import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { validate, schemas, sanitizePhoneNumber } = require('../middleware/validation');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');
const { syncTargetsFromWhatsApp } = require('../services/targetSyncService');

type TargetRow = {
  id?: string;
  name?: string;
  phone_number?: string;
  type?: string;
  active?: boolean;
  updated_at?: string | null;
  created_at?: string | null;
  notes?: string | null;
};

const ON_DEMAND_TARGET_SYNC_MIN_INTERVAL_MS = Math.max(
  Number(process.env.TARGET_ON_DEMAND_SYNC_MIN_INTERVAL_MS || 30_000),
  5_000
);
let lastOnDemandTargetSyncAtMs = 0;

const normalizeDisplayText = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim();
const stripTargetTypeTags = (value: string) =>
  String(value || '')
    .replace(/\((group|channel|status|individual)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const isNumericOnlyLabel = (value: unknown) => /^\d{6,}$/.test(String(value || '').trim());

const normalizeTargetType = (type: unknown, phoneNumber: unknown) => {
  const rawType = String(type || '').trim().toLowerCase();
  const rawPhone = String(phoneNumber || '').trim().toLowerCase();
  if (rawPhone === 'status@broadcast') return 'status';
  if (rawPhone.includes('@newsletter')) return 'channel';
  if (rawPhone.endsWith('@g.us')) return 'group';
  if (rawPhone.endsWith('@s.whatsapp.net') || rawPhone.endsWith('@lid')) return 'individual';
  if (rawType === 'status' || rawType === 'channel' || rawType === 'group' || rawType === 'individual') {
    return rawType;
  }
  return 'individual';
};

const normalizeChannelJidForKey = (phoneNumber: string) => {
  const trimmed = String(phoneNumber || '').trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().includes('@newsletter')) {
    const tokenMatch = trimmed.match(/[a-z0-9._-]+@newsletter(?:_[a-z0-9_-]+)?/i);
    return (tokenMatch?.[0] || trimmed).toLowerCase();
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (/^[a-z0-9._-]{6,}$/i.test(compact)) {
    return `${compact.toLowerCase()}@newsletter`;
  }
  const digits = trimmed.replace(/[^0-9]/g, '');
  return digits ? `${digits}@newsletter` : trimmed.toLowerCase();
};

const normalizeGroupJidForKey = (phoneNumber: string) => {
  const trimmed = String(phoneNumber || '').trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().endsWith('@g.us')) return trimmed.toLowerCase();
  const cleaned = trimmed.replace(/[^0-9-]/g, '');
  return cleaned ? `${cleaned}@g.us` : trimmed.toLowerCase();
};

const normalizeIndividualJidForKey = (phoneNumber: string) => {
  const trimmed = String(phoneNumber || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  const cleaned = sanitizePhoneNumber(trimmed).replace(/[^0-9]/g, '');
  return cleaned ? `${cleaned}@s.whatsapp.net` : trimmed.toLowerCase();
};

const normalizePhoneForKey = (type: string, phoneNumber: string) => {
  const raw = String(phoneNumber || '').trim();
  if (!raw) return '';
  if (type === 'status') return 'status@broadcast';
  if (type === 'group') return normalizeGroupJidForKey(raw);
  if (type === 'channel') return normalizeChannelJidForKey(raw);
  return normalizeIndividualJidForKey(raw);
};

const isPlaceholderChannelName = (name: unknown) => /^channel[\s_-]*\d+$/i.test(String(name || '').trim());
const isRawChannelJidLabel = (name: unknown) => String(name || '').trim().toLowerCase().includes('@newsletter');
const hasOnlyDigitsAndSeparators = (name: unknown) => /^[\d\s._-]{6,}$/.test(String(name || '').trim());
const isValidPhoneForType = (type: string, phoneNumber: string) => {
  const phone = String(phoneNumber || '').trim().toLowerCase();
  if (!phone) return false;
  if (type === 'status') return phone === 'status@broadcast';
  if (type === 'group') return /^[0-9-]{6,}@g\.us$/.test(phone);
  if (type === 'channel') return /^[a-z0-9._-]+@newsletter(?:_[a-z0-9_-]+)?$/.test(phone);
  return /^[0-9]{6,}@s\.whatsapp\.net$/.test(phone) || phone.endsWith('@lid');
};

const cleanupDisplayName = (value: unknown, type: string) => {
  let cleaned = normalizeDisplayText(value);
  if (!cleaned) return '';

  if (/\btarget\b/i.test(cleaned)) {
    const beforeTarget = normalizeDisplayText(cleaned.split(/\btarget\b/i)[0]);
    if (beforeTarget.length >= 3) {
      cleaned = beforeTarget;
    }
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 4) {
    const first = words[0]?.toLowerCase();
    const last = words[words.length - 1]?.toLowerCase();
    if (first && first === last) {
      cleaned = words.slice(0, -1).join(' ');
    }
  }

  if (cleaned.length > 96) {
    cleaned = cleaned.slice(0, 96).trim();
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length >= 6) {
    const half = Math.floor(tokens.length / 2);
    const left = tokens.slice(0, half).join(' ').toLowerCase();
    const right = tokens.slice(half).join(' ').toLowerCase();
    if (left && left === right) {
      cleaned = tokens.slice(0, half).join(' ');
    }
  }

  return cleaned;
};

const normalizeTargetName = (name: unknown, type: string, phone: string) => {
  const fallback = String(phone || '').trim();
  let cleaned = normalizeDisplayText(name);
  if (!cleaned) return type === 'status' ? 'My Status' : fallback;
  const repeatedTypeMentions = (cleaned.match(/\((group|channel|status|individual)\)/gi) || []).length;
  if (repeatedTypeMentions > 1) {
    const firstSegment = normalizeDisplayText(cleaned.split(/\((group|channel|status|individual)\)/i)[0]);
    if (firstSegment) cleaned = firstSegment;
  }
  cleaned = stripTargetTypeTags(cleaned);
  cleaned = cleanupDisplayName(cleaned, type);
  if (!cleaned) return type === 'status' ? 'My Status' : fallback;
  if (
    type === 'channel' &&
    (isPlaceholderChannelName(cleaned) ||
      isRawChannelJidLabel(cleaned) ||
      isNumericOnlyLabel(cleaned) ||
      hasOnlyDigitsAndSeparators(cleaned))
  )
    return '';
  return cleaned;
};

const scoreTargetForResponse = (target: { active?: boolean; type?: string; name?: string; updated_at?: string | null; created_at?: string | null }) => {
  const normalizedName = normalizeDisplayText(target.name);
  const typeMentions = (normalizedName.match(/\((group|channel|status|individual)\)/gi) || []).length;
  const activeScore = target.active ? 1000 : 0;
  const placeholderPenalty =
    target.type === 'channel' && isPlaceholderChannelName(normalizedName)
      ? -200
      : 0;
  const rawJidPenalty = /@(g\.us|newsletter(?:_[a-z0-9_-]+)?|s\.whatsapp\.net|lid)/i.test(normalizedName)
    ? -220
    : 0;
  const repeatedLabelPenalty = typeMentions > 1 ? -120 : 0;
  const missingNamePenalty = !normalizedName ? -240 : 0;
  const updated = Date.parse(String(target.updated_at || target.created_at || 0));
  const freshness = Number.isFinite(updated) ? updated / 1_000_000_000_000 : 0;
  return activeScore + placeholderPenalty + rawJidPenalty + repeatedLabelPenalty + missingNamePenalty + freshness;
};

const dedupeTargetsForResponse = (rows: TargetRow[]) => {
  const byKey = new Map<string, TargetRow>();

  for (const row of rows || []) {
    const type = normalizeTargetType(row.type, row.phone_number);
    if (type === 'channel' && (isPlaceholderChannelName(row.name) || isRawChannelJidLabel(row.name))) {
      continue;
    }
    const phone = normalizePhoneForKey(type, String(row.phone_number || ''));
    if (!type || !phone) continue;
    const key = `${type}:${phone}`;
    const normalizedRow: TargetRow = {
      ...row,
      type,
      phone_number: phone,
      name: normalizeTargetName(row.name, type, phone)
    };
    if (type === 'channel' && !normalizeDisplayText(normalizedRow.name)) {
      continue;
    }
    const current = byKey.get(key);
    if (!current || scoreTargetForResponse(normalizedRow) > scoreTargetForResponse(current)) {
      byKey.set(key, normalizedRow);
    }
  }

  return Array.from(byKey.values())
    .map((row) => {
      const type = normalizeTargetType(row.type, row.phone_number);
      const phone = String(row.phone_number || '').trim();
      const name = normalizeTargetName(row.name, type, phone);
      const fallbackName = type === 'status' ? 'My Status' : phone;
      return {
        ...row,
        type,
        phone_number: phone,
        name: name || fallbackName
      };
    })
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
};

const sanitizeStoredTargets = async (supabase: ReturnType<typeof getSupabaseClient>, rows: TargetRow[]) => {
  if (!supabase || !Array.isArray(rows) || !rows.length) return;

  for (const row of rows) {
    const id = String(row?.id || '').trim();
    if (!id) continue;

    const computedType = normalizeTargetType(row.type, row.phone_number);
    const normalizedPhone = normalizePhoneForKey(computedType, String(row.phone_number || ''));
    const normalizedName = normalizeTargetName(row.name, computedType, normalizedPhone);

    const patch: Record<string, unknown> = {};
    if (String(row.type || '').trim() !== computedType) patch.type = computedType;
    if (String(row.phone_number || '').trim().toLowerCase() !== normalizedPhone) {
      patch.phone_number = normalizedPhone;
    }

    const shouldDeactivate =
      !normalizedPhone ||
      !isValidPhoneForType(computedType, normalizedPhone) ||
      (computedType === 'channel' && !normalizedName) ||
      (computedType === 'status' && normalizedPhone !== 'status@broadcast');

    if (shouldDeactivate) {
      if (row.active === true) patch.active = false;
    } else {
      const fallbackName = computedType === 'status' ? 'My Status' : normalizedPhone;
      const safeName = normalizedName || fallbackName;
      if (normalizeDisplayText(row.name) !== safeName) patch.name = safeName;
    }

    if (Object.keys(patch).length) {
      await supabase.from('targets').update(patch).eq('id', id);
    }

    // Keep response rows in sync with normalization applied above so callers
    // do not need a second refresh to see cleaned names/jids/active state.
    row.type = computedType;
    row.phone_number = normalizedPhone;
    if (shouldDeactivate) {
      row.active = false;
    } else {
      const fallbackName = computedType === 'status' ? 'My Status' : normalizedPhone;
      row.name = normalizedName || fallbackName;
    }
  }
};

const targetRoutes = () => {
  const router = express.Router();
  
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  router.get('/', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const whatsapp = req.app.locals.whatsapp as {
        getStatus?: () => { status?: string };
      } | null;
      const forceSync =
        String((req.query.sync ?? req.query.refresh ?? 'false')).toLowerCase() === 'true';
      const now = Date.now();
      const shouldSyncNow =
        forceSync || now - lastOnDemandTargetSyncAtMs >= ON_DEMAND_TARGET_SYNC_MIN_INTERVAL_MS;

      if (shouldSyncNow) {
        lastOnDemandTargetSyncAtMs = now;
        try {
          await syncTargetsFromWhatsApp(whatsapp, {
            includeStatus: true,
            skipIfDisconnected: true,
            strict: true
          });
        } catch {
          // Best-effort sync only; list endpoint should still respond.
        }
      }

      const { data: targets, error } = await supabase
        .from('targets')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      const rows = (targets || []) as TargetRow[];
      await sanitizeStoredTargets(supabase, rows);
      res.json(dedupeTargetsForResponse(rows));
    } catch (error) {
      console.error('Error fetching targets:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  const normalizeGroupJid = (phoneNumber: string) => {
    const cleaned = phoneNumber.replace(/[^0-9-]/g, '');
    return cleaned ? `${cleaned}@g.us` : phoneNumber;
  };

  const normalizeChannelJid = (phoneNumber: string) => {
    const trimmed = String(phoneNumber || '').trim();
    if (!trimmed) return trimmed;
    if (trimmed.toLowerCase().includes('@newsletter')) {
      const tokenMatch = trimmed.match(/[a-z0-9._-]+@newsletter(?:_[a-z0-9_-]+)?/i);
      return tokenMatch?.[0] || trimmed;
    }
    const compact = trimmed.replace(/\s+/g, '');
    if (/^[a-z0-9._-]{6,}$/i.test(compact)) {
      return `${compact.toLowerCase()}@newsletter`;
    }
    const cleaned = trimmed.replace(/[^0-9]/g, '');
    return cleaned ? `${cleaned}@newsletter` : trimmed;
  };

  const normalizeIndividualJid = (phoneNumber: string) => {
    const cleaned = sanitizePhoneNumber(phoneNumber).replace(/[^0-9]/g, '');
    return cleaned ? `${cleaned}@s.whatsapp.net` : phoneNumber;
  };

  const normalizeTargetPayload = (payload: Record<string, unknown>) => {
    const next = { ...payload } as Record<string, unknown> & { type?: string; phone_number?: string };
    if (next.type === 'status') {
      next.phone_number = 'status@broadcast';
      return next;
    }
    if (typeof next.phone_number === 'string') {
      const trimmed = next.phone_number.trim();
      if (next.type === 'individual') {
        next.phone_number = normalizeIndividualJid(trimmed);
      } else if (next.type === 'group') {
        next.phone_number = normalizeGroupJid(trimmed);
      } else if (next.type === 'channel') {
        next.phone_number = normalizeChannelJid(trimmed);
      } else {
        next.phone_number = trimmed;
      }
    }
    return next;
  };

  router.post('/sync', async (req: Request, res: Response) => {
    try {
      const whatsapp = req.app.locals.whatsapp as {
        getStatus?: () => { status?: string };
      } | null;
      const includeStatus =
        String((req.body as { includeStatus?: unknown })?.includeStatus ?? req.query.includeStatus ?? 'true').toLowerCase() !==
        'false';
      const strict =
        String((req.body as { strict?: unknown })?.strict ?? req.query.strict ?? 'true').toLowerCase() !== 'false';

      const result = await syncTargetsFromWhatsApp(whatsapp, { includeStatus, strict });
      if (!result.ok) {
        return res.status(400).json({ error: result.reason || 'WhatsApp is not connected' });
      }
      return res.json(result);
    } catch (error) {
      console.error('Error syncing targets:', error);
      return res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/', validate(schemas.target), async (req: Request, res: Response) => {
    try {
      const payload = normalizeTargetPayload(req.body);
      const { data: target, error } = await getDb()
        .from('targets')
        .insert(payload)
        .select()
        .single();
      
      if (error) throw error;
      res.json(target);
    } catch (error) {
      console.error('Error creating target:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.put('/:id', validate(schemas.target), async (req: Request, res: Response) => {
    try {
      const payload = normalizeTargetPayload(req.body);
      const { data: target, error } = await getDb()
        .from('targets')
        .update(payload)
        .eq('id', req.params.id)
        .select()
        .single();
      
      if (error) throw error;
      res.json(target);
    } catch (error) {
      console.error('Error updating target:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { error } = await getDb()
        .from('targets')
        .delete()
        .eq('id', req.params.id);
      
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting target:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = targetRoutes;
