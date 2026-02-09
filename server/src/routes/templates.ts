import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { validate, schemas } = require('../middleware/validation');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const getDb = () => {
  const supabase = getSupabaseClient();
  if (!supabase) throw serviceUnavailable('Database not available');
  return supabase;
};

// Extract variable names from template content (e.g., {{title}}, {{description}})
function extractVariables(content: string) {
  const regex = /\{\{\s*(\w+)\s*\}\}/g;
  const input = String(content ?? '');
  const variables = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    if (match[1]) {
      variables.add(match[1]);
    }
  }
  return Array.from(variables);
}

const normalizeTemplatePayload = (payload: Record<string, unknown>) => {
  const next = { ...payload } as Record<string, unknown> & {
    send_mode?: 'image' | 'image_only' | 'link_preview' | 'text_only';
    send_images?: boolean;
  };

  const explicitMode = next.send_mode;

  if (explicitMode === 'image_only') {
    next.send_mode = 'image_only';
    next.send_images = false;
    return next;
  }

  if (explicitMode === 'image') {
    if (next.send_images === false) {
      next.send_mode = 'image_only';
      next.send_images = false;
      return next;
    }
    next.send_mode = 'image';
    next.send_images = true;
    return next;
  }

  if (explicitMode === 'link_preview' || explicitMode === 'text_only') {
    next.send_mode = explicitMode;
    next.send_images = false;
    return next;
  }

  const legacyMode = next.send_images === false ? 'link_preview' : 'image';
  next.send_mode = legacyMode;
  next.send_images = legacyMode === 'image';
  return next;
};

const normalizeTemplateResponse = <T extends Record<string, unknown>>(template: T): T => {
  const next = { ...template } as T & {
    send_mode?: 'image' | 'link_preview' | 'text_only' | 'image_only' | null;
    send_images?: boolean | null;
  };

  if (next.send_mode === 'image' && next.send_images === false) {
    next.send_mode = 'image_only';
  }

  if (next.send_mode === 'image_only') {
    next.send_images = false;
  }

  return next;
};

const templateRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const { data: templates, error } = await getDb()
        .from('templates')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json((templates || []).map((template: Record<string, unknown>) => normalizeTemplateResponse(template)));
    } catch (error) {
      console.error('Error fetching templates:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/', validate(schemas.template), async (req: Request, res: Response) => {
    try {
      // Extract variables from template content
      const payload = normalizeTemplatePayload(req.body);
      const variables = extractVariables(String(payload.content || ''));
      
      const { data: template, error } = await getDb()
        .from('templates')
        .insert({ ...payload, variables })
        .select()
        .single();
      
      if (error) throw error;
      res.json(normalizeTemplateResponse(template));
    } catch (error) {
      console.error('Error creating template:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.put('/:id', validate(schemas.template), async (req: Request, res: Response) => {
    try {
      // Extract variables from template content
      const payload = normalizeTemplatePayload(req.body);
      const variables = extractVariables(String(payload.content || ''));
      
      const { data: template, error } = await getDb()
        .from('templates')
        .update({ ...payload, variables })
        .eq('id', req.params.id)
        .select()
        .maybeSingle();
      
      if (error) throw error;
      if (!template) {
        return res.status(404).json({ error: 'Template not found' });
      }
      res.json(normalizeTemplateResponse(template));
    } catch (error) {
      console.error('Error updating template:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { error } = await getDb()
        .from('templates')
        .delete()
        .eq('id', req.params.id);
      
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting template:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Get available variables for templates based on feed items
  router.get('/available-variables', async (req: Request, res: Response) => {
    try {
      const feedId = typeof req.query.feed_id === 'string' ? req.query.feed_id : null;

      // Get recent feed items to extract available fields
      let query = getDb().from('feed_items').select('*').order('created_at', { ascending: false }).limit(20);
      if (feedId) {
        query = query.eq('feed_id', feedId);
      }

      const { data: items, error } = await query;
      
      if (error) throw error;
      
      // Standard feed item fields that are always available
      const standardFields = [
        { name: 'title', description: 'Article title' },
        { name: 'description', description: 'Article description/summary' },
        { name: 'content', description: 'Full article content' },
        { name: 'link', description: 'Article URL' },
        { name: 'author', description: 'Article author' },
        { name: 'pub_date', description: 'Publication date' },
        { name: 'image_url', description: 'Article image URL' },
        { name: 'categories', description: 'Article categories' },
        { name: 'normalized_url', description: 'Normalized URL (for dedupe)' },
        { name: 'content_hash', description: 'Content hash (for dedupe)' },
        { name: 'guid', description: 'Feed GUID' }
      ];
      
      // Extract additional fields from raw_data
      const additionalFields = new Set<string>();
      const ignoredRawKeys = new Set(['normalizedTitle', 'normalizedUrl', 'hash', 'source']);

      const appendRawField = (key: string, value: unknown) => {
        if (!key || ignoredRawKeys.has(key)) return;
        if (!/^[a-zA-Z_]\w{0,63}$/.test(key)) return;
        if (value == null) return;
        if (typeof value === 'object') return;
        additionalFields.add(key);
      };

      (items || []).forEach((item: Record<string, unknown>) => {
        if (item.raw_data && typeof item.raw_data === 'object') {
          const rawData = item.raw_data as Record<string, unknown>;

          Object.entries(rawData).forEach(([key, value]) => {
            if (standardFields.find((field) => field.name === key)) return;
            appendRawField(key, value);
          });

          const source = rawData.source;
          if (source && typeof source === 'object') {
            Object.entries(source as Record<string, unknown>).forEach(([key, value]) => {
              if (standardFields.find((field) => field.name === key)) return;
              appendRawField(key, value);
            });
          }
        }
      });
      
      const allFields = [
        ...standardFields,
        ...Array.from(additionalFields).map(name => ({ 
          name, 
          description: 'Custom field from feed' 
        }))
      ];
      
      res.json(allFields);
    } catch (error) {
      console.error('Error fetching available variables:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = templateRoutes;
