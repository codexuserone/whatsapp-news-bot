import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { validate, schemas, sanitizePhoneNumber } = require('../middleware/validation');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const targetRoutes = () => {
  const router = express.Router();
  
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const { data: targets, error } = await getDb()
        .from('targets')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json(targets);
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
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    return cleaned ? `${cleaned}@newsletter` : phoneNumber;
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

  type SyncCandidate = {
    name: string;
    phone_number: string;
    type: 'group' | 'channel' | 'status';
    active: boolean;
    notes?: string | null;
  };

  type ExistingTarget = {
    id: string;
    name: string;
    phone_number: string;
    type: 'individual' | 'group' | 'channel' | 'status';
    active: boolean;
    notes?: string | null;
  };

  router.post('/sync', async (req: Request, res: Response) => {
    try {
      const whatsapp = req.app.locals.whatsapp as {
        getStatus?: () => { status?: string };
        getGroups?: () => Promise<Array<{ jid?: string; name?: string; size?: number }>>;
        getChannels?: () => Promise<Array<{ jid?: string; name?: string; subscribers?: number }>>;
        getChannelsWithDiagnostics?: () => Promise<{
          channels: Array<{ jid?: string; name?: string; subscribers?: number }>;
          diagnostics?: Record<string, unknown>;
        }>;
      } | null;

      if (!whatsapp || whatsapp.getStatus?.()?.status !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp is not connected' });
      }

      const groupsRaw = await (whatsapp.getGroups?.() || []);
      const channelsWithDiagnostics =
        typeof whatsapp.getChannelsWithDiagnostics === 'function'
          ? await whatsapp.getChannelsWithDiagnostics()
          : null;
      const channelsRaw = channelsWithDiagnostics?.channels || (await (whatsapp.getChannels?.() || []));

      const includeStatus =
        String((req.body as { includeStatus?: unknown })?.includeStatus ?? req.query.includeStatus ?? 'true').toLowerCase() !==
        'false';

      const candidates: SyncCandidate[] = [];
      const usedJids = new Set<string>();

      for (const group of groupsRaw) {
        const jid = String(group?.jid || '').trim();
        if (!jid || usedJids.has(jid)) continue;
        usedJids.add(jid);
        candidates.push({
          name: String(group?.name || jid).trim() || jid,
          phone_number: jid,
          type: 'group',
          active: true,
          notes: Number.isFinite(group?.size) ? `${Number(group?.size || 0)} members` : null
        });
      }

      for (const channel of channelsRaw) {
        const jid = String(channel?.jid || '').trim();
        if (!jid || usedJids.has(jid)) continue;
        usedJids.add(jid);
        candidates.push({
          name: String(channel?.name || jid).trim() || jid,
          phone_number: jid,
          type: 'channel',
          active: true,
          notes: Number.isFinite(channel?.subscribers) ? `${Number(channel?.subscribers || 0)} subscribers` : null
        });
      }

      if (includeStatus && !usedJids.has('status@broadcast')) {
        candidates.push({
          name: 'My Status',
          phone_number: 'status@broadcast',
          type: 'status',
          active: true,
          notes: 'Posts to your WhatsApp Status'
        });
      }

      const { data: existingRows, error: existingError } = await getDb().from('targets').select('*');
      if (existingError) throw existingError;

      const existing = (existingRows || []) as ExistingTarget[];
      const existingByJid = new Map<string, ExistingTarget>();
      for (const row of existing) {
        const jid = String(row.phone_number || '').trim();
        if (!jid) continue;
        existingByJid.set(jid, row);
      }

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;

      for (const candidate of candidates) {
        const current = existingByJid.get(candidate.phone_number);
        if (!current) {
          const { error: insertError } = await getDb().from('targets').insert(candidate);
          if (insertError) throw insertError;
          inserted += 1;
          continue;
        }

        const patch: Partial<SyncCandidate> = {};
        if (current.name !== candidate.name) patch.name = candidate.name;
        if (current.type !== candidate.type) patch.type = candidate.type;
        if (String(current.notes || '') !== String(candidate.notes || '')) patch.notes = candidate.notes || null;

        if (!Object.keys(patch).length) {
          unchanged += 1;
          continue;
        }

        const { error: updateError } = await getDb()
          .from('targets')
          .update(patch)
          .eq('id', current.id);
        if (updateError) throw updateError;
        updated += 1;
      }

      return res.json({
        ok: true,
        discovered: {
          groups: groupsRaw.length,
          channels: channelsRaw.length,
          status: includeStatus ? 1 : 0
        },
        candidates: candidates.length,
        inserted,
        updated,
        unchanged,
        diagnostics: channelsWithDiagnostics?.diagnostics || null
      });
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
