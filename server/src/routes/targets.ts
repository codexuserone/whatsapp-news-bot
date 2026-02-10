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

const normalizeChannelJidForKey = (phoneNumber: string) => {
  const trimmed = String(phoneNumber || '').trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().includes('@newsletter')) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[^0-9]/g, '');
  return digits ? `${digits}@newsletter` : trimmed.toLowerCase();
};

const normalizePhoneForKey = (type: string, phoneNumber: string) => {
  const raw = String(phoneNumber || '').trim();
  if (!raw) return '';
  if (type === 'channel') return normalizeChannelJidForKey(raw);
  return raw.toLowerCase();
};

const isPlaceholderChannelName = (name: unknown) => /^channel\s+\d+$/i.test(String(name || '').trim());
const isRawChannelJidLabel = (name: unknown) => String(name || '').trim().toLowerCase().includes('@newsletter');

const scoreTargetForResponse = (target: { active?: boolean; type?: string; name?: string; updated_at?: string | null; created_at?: string | null }) => {
  const activeScore = target.active ? 1000 : 0;
  const placeholderPenalty =
    target.type === 'channel' && isPlaceholderChannelName(target.name)
      ? -200
      : 0;
  const updated = Date.parse(String(target.updated_at || target.created_at || 0));
  const freshness = Number.isFinite(updated) ? updated / 1_000_000_000_000 : 0;
  return activeScore + placeholderPenalty + freshness;
};

const dedupeTargetsForResponse = (rows: TargetRow[]) => {
  const byKey = new Map<string, TargetRow>();

  for (const row of rows || []) {
    const type = String(row.type || '').trim();
    if (type === 'channel' && (isPlaceholderChannelName(row.name) || isRawChannelJidLabel(row.name))) {
      continue;
    }
    const phone = normalizePhoneForKey(type, String(row.phone_number || ''));
    if (!type || !phone) continue;
    const key = `${type}:${phone}`;
    const current = byKey.get(key);
    if (!current || scoreTargetForResponse(row) > scoreTargetForResponse(current)) {
      byKey.set(key, row);
    }
  }

  return Array.from(byKey.values()).sort((a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || ''))
  );
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
      const whatsapp = req.app.locals.whatsapp as {
        getStatus?: () => { status?: string };
      } | null;
      try {
        await syncTargetsFromWhatsApp(whatsapp, {
          includeStatus: true,
          skipIfDisconnected: true,
          strict: true
        });
      } catch {
        // Best-effort sync only; list endpoint should still respond.
      }

      const { data: targets, error } = await getDb()
        .from('targets')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json(dedupeTargetsForResponse(targets || []));
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
      return trimmed;
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
