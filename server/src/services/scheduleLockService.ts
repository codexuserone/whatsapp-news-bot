import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Distributed locking using PostgreSQL advisory locks.
 * Ensures only one instance can run a schedule at a time across all Render instances.
 */

const SCHEDULE_LOCK_NAMESPACE = 2147483647; // Max int32 for namespace

/**
 * Convert a schedule ID to a 32-bit integer lock ID
 * Uses simple hash for string IDs
 */
const scheduleIdToLockId = (scheduleId: string): number => {
  let hash = 0;
  for (let i = 0; i < scheduleId.length; i++) {
    const char = scheduleId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Ensure positive and within int32 range
  return Math.abs(hash) % 2147483647;
};

export interface ScheduleLockResult {
  acquired: boolean;
  release?: () => Promise<void>;
  holderInfo?: string | null;
}

/**
 * Try to acquire a distributed lock for a schedule.
 * Returns release function if acquired, null if lock is held by another instance.
 */
export const acquireScheduleLock = async (
  supabase: SupabaseClient,
  scheduleId: string,
  options?: { wait?: boolean; timeoutMs?: number }
): Promise<ScheduleLockResult> => {
  const lockId = scheduleIdToLockId(scheduleId);
  
  try {
    // Try to acquire advisory lock (non-blocking by default)
    const { data, error } = await supabase.rpc('pg_try_advisory_lock', {
      key: lockId
    });

    if (error) {
      // RPC might not exist, fall back to alternative method
      return await acquireLockViaTable(supabase, scheduleId, options);
    }

    if (data === true) {
      // Lock acquired
      const release = async () => {
        try {
          await supabase.rpc('pg_advisory_unlock', { key: lockId });
        } catch (e) {
          // Ignore unlock errors
        }
      };
      return { acquired: true, release };
    }

    // Lock held by another instance
    return { acquired: false, holderInfo: 'held_by_another_instance' };
  } catch (e) {
    // Fallback to table-based locking if advisory locks not available
    return await acquireLockViaTable(supabase, scheduleId, options);
  }
};

/**
 * Fallback: Use a table-based lock if advisory locks aren't available.
 * Creates a lock row with locked_until timestamp.
 */
const acquireLockViaTable = async (
  supabase: SupabaseClient,
  scheduleId: string,
  options?: { timeoutMs?: number }
): Promise<ScheduleLockResult> => {
  const now = new Date();
  const lockDurationMs = options?.timeoutMs || 300000; // 5 minute default
  const lockedUntil = new Date(now.getTime() + lockDurationMs);
  const instanceId = process.env.RENDER_INSTANCE_ID || 
                     process.env.HOSTNAME || 
                     `instance_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const nowIso = now.toISOString();
  const lockedUntilIso = lockedUntil.toISOString();

  const isMissingTableError = (error: unknown) => {
    const message = String((error as { message?: unknown })?.message || error).toLowerCase();
    return message.includes('does not exist') || message.includes('schedule_locks');
  };

  const isUniqueViolation = (error: unknown) => {
    const code = String((error as { code?: unknown })?.code || '');
    const message = String((error as { message?: unknown })?.message || error).toLowerCase();
    return code === '23505' || message.includes('duplicate key');
  };

  const buildRelease = () => async () => {
    try {
      await supabase
        .from('schedule_locks')
        .delete()
        .eq('schedule_id', scheduleId)
        .eq('locked_by', instanceId);
    } catch {
      // Ignore release errors
    }
  };

  const tryUpdateLock = async (
    filter: (query: any) => any
  ): Promise<{ acquired: boolean; release?: () => Promise<void>; error?: unknown }> => {
    const query = supabase
      .from('schedule_locks')
      .update({
        locked_by: instanceId,
        locked_at: nowIso,
        locked_until: lockedUntilIso
      })
      .eq('schedule_id', scheduleId);

    const { data, error } = await filter(query)
      .select('schedule_id')
      .limit(1);

    if (error) {
      if (isMissingTableError(error)) {
        // Allow operation without locking if table isn't present.
        return { acquired: true };
      }
      return { acquired: false, error };
    }

    if (Array.isArray(data) && data.length > 0) {
      return { acquired: true, release: buildRelease() };
    }

    return { acquired: false };
  };

  try {
    // 1) Refresh a lock already held by this instance.
    const ownLock = await tryUpdateLock((query) => query.eq('locked_by', instanceId));
    if (ownLock.acquired) {
      return ownLock.release ? { acquired: true, release: ownLock.release } : { acquired: true };
    }

    // 2) Acquire an expired lock.
    const expiredLock = await tryUpdateLock((query) => query.lt('locked_until', nowIso));
    if (expiredLock.acquired) {
      return expiredLock.release ? { acquired: true, release: expiredLock.release } : { acquired: true };
    }

    // 3) Create a brand-new lock row.
    const { error: insertError } = await supabase
      .from('schedule_locks')
      .insert({
        schedule_id: scheduleId,
        locked_by: instanceId,
        locked_at: nowIso,
        locked_until: lockedUntilIso
      })
      .select()
      .single();

    if (insertError) {
      if (isMissingTableError(insertError)) {
        // Allow operation without locking
        return { acquired: true };
      }
      if (isUniqueViolation(insertError)) {
        const { data: lockRow } = await supabase
          .from('schedule_locks')
          .select('locked_by,locked_until')
          .eq('schedule_id', scheduleId)
          .maybeSingle();
        const lockedBy = String((lockRow as { locked_by?: string | null })?.locked_by || 'unknown');
        const lockedUntilAt = String((lockRow as { locked_until?: string | null })?.locked_until || '');
        return {
          acquired: false,
          holderInfo: lockedUntilAt
            ? `held_by_${lockedBy}_until_${lockedUntilAt}`
            : `held_by_${lockedBy}`
        };
      }
      return { acquired: false, holderInfo: null };
    }

    return { acquired: true, release: buildRelease() };
  } catch {
    // Graceful degradation - allow operation if locking fails
    return { acquired: true };
  }
};

/**
 * Release a schedule lock manually (usually not needed if using withScheduleLock)
 */
export const releaseScheduleLock = async (
  supabase: SupabaseClient,
  scheduleId: string
): Promise<void> => {
  const lockId = scheduleIdToLockId(scheduleId);
  
  try {
    await supabase.rpc('pg_advisory_unlock', { key: lockId });
  } catch (e) {
    // Ignore errors
  }

  // Also try table-based cleanup
  try {
    await supabase
      .from('schedule_locks')
      .delete()
      .eq('schedule_id', scheduleId);
  } catch (e) {
    // Ignore errors
  }
};

/**
 * Execute a function with distributed locking for a schedule.
 * Automatically acquires and releases the lock.
 */
export const withScheduleLock = async <T>(
  supabase: SupabaseClient,
  scheduleId: string,
  fn: () => Promise<T>,
  options?: { timeoutMs?: number; skipIfLocked?: boolean }
): Promise<{ result: T | null; skipped: boolean; reason?: string }> => {
  const lockResult = await acquireScheduleLock(supabase, scheduleId, options);

  if (!lockResult.acquired) {
    if (options?.skipIfLocked !== false) {
      return { result: null, skipped: true, reason: 'Schedule locked by another instance' };
    }
    // Wait and retry once
    await new Promise(r => setTimeout(r, 1000));
    const retryResult = await acquireScheduleLock(supabase, scheduleId, options);
    if (!retryResult.acquired) {
      return { result: null, skipped: true, reason: 'Schedule locked by another instance (retry failed)' };
    }
    // Use retry result
    try {
      const result = await fn();
      return { result, skipped: false };
    } finally {
      if (retryResult.release) {
        await retryResult.release();
      }
    }
  }

  try {
    const result = await fn();
    return { result, skipped: false };
  } finally {
    if (lockResult.release) {
      await lockResult.release();
    }
  }
};

/**
 * Cleanup stale locks (should be called periodically)
 */
export const cleanupStaleLocks = async (supabase: SupabaseClient): Promise<number> => {
  try {
    const { data, error } = await supabase
      .from('schedule_locks')
      .delete()
      .lt('locked_until', new Date().toISOString())
      .select('schedule_id');

    if (error) {
      return 0;
    }

    return data?.length || 0;
  } catch (e) {
    return 0;
  }
};
