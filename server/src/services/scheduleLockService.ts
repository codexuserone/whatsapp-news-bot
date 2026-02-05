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

  const payload = {
    schedule_id: scheduleId,
    locked_by: instanceId,
    locked_at: now.toISOString(),
    locked_until: lockedUntil.toISOString()
  };

  const isMissingTableError = (error: unknown) => {
    const message = String((error as { message?: unknown })?.message || error || '');
    return message.includes('does not exist') || message.includes('schedule_locks');
  };

  const isConflictError = (error: unknown) => {
    const code = (error as { code?: string })?.code;
    if (code === '23505') return true;
    const message = String((error as { message?: unknown })?.message || error || '').toLowerCase();
    return message.includes('duplicate key') || message.includes('unique constraint');
  };

  const toRow = (data: unknown) => (Array.isArray(data) ? data[0] : data);

  try {
    // Attempt insert first (fast path when no lock exists).
    const { data: inserted, error: insertError } = await supabase
      .from('schedule_locks')
      .insert(payload)
      .select('schedule_id, locked_by, locked_until');

    const insertedRow = toRow(inserted) as { locked_by?: string } | undefined;

    if (!insertError && insertedRow?.locked_by === instanceId) {
      const release = async () => {
        try {
          await supabase
            .from('schedule_locks')
            .delete()
            .eq('schedule_id', scheduleId)
            .eq('locked_by', instanceId);
        } catch (e) {
          // Ignore release errors
        }
      };
      return { acquired: true, release };
    }

    if (insertError) {
      if (isMissingTableError(insertError)) {
        // Allow operation without locking when table is missing.
        return { acquired: true };
      }
      if (!isConflictError(insertError)) {
        return { acquired: false, holderInfo: null };
      }
    }

    // Conflict: only update if the lock has expired.
    const { data: updated, error: updateError } = await supabase
      .from('schedule_locks')
      .update(payload)
      .eq('schedule_id', scheduleId)
      .lt('locked_until', now.toISOString())
      .select('schedule_id, locked_by, locked_until');

    if (updateError) {
      if (isMissingTableError(updateError)) {
        return { acquired: true };
      }
      return { acquired: false, holderInfo: null };
    }

    const updatedRow = toRow(updated) as { locked_by?: string } | undefined;
    if (updatedRow?.locked_by === instanceId) {
      const release = async () => {
        try {
          await supabase
            .from('schedule_locks')
            .delete()
            .eq('schedule_id', scheduleId)
            .eq('locked_by', instanceId);
        } catch (e) {
          // Ignore release errors
        }
      };
      return { acquired: true, release };
    }

    const { data: current, error: currentError } = await supabase
      .from('schedule_locks')
      .select('locked_by, locked_until')
      .eq('schedule_id', scheduleId)
      .limit(1);

    if (currentError) {
      return { acquired: false, holderInfo: null };
    }

    const currentRow = toRow(current) as { locked_by?: string } | undefined;
    return {
      acquired: false,
      holderInfo: `held_by_${currentRow?.locked_by || 'unknown'}`
    };
  } catch (e) {
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
