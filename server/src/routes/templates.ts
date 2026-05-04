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

const normalizeModernSendMode = (value: unknown) => {
  const mode = String(value || '').trim();
  if (mode === 'image' || mode === 'auto_media') return 'auto_media';
  if (mode === 'image_only' || mode === 'media_only') return 'media_only';
  if (mode === 'link_preview' || mode === 'text_preview') return 'text_preview';
  if (mode === 'text_only') return 'text_only';
  return 'auto_media';
};

const normalizeStatusBackgroundColor = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-f]{6}$/i.test(withHash) ? withHash.toLowerCase() : null;
};

const normalizeStatusFont = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.floor(parsed), 0), 8);
};

const normalizeMediaSource = (value: unknown) => {
  const source = String(value || '').trim().toLowerCase();
  if (source === 'image' || source === 'featured_image') return 'image';
  if (source === 'video' || source === 'feed_video') return 'video';
  return 'auto';
};

const normalizeTemplateSequenceSteps = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  return value
    .map((rawStep, index) => {
      const step = rawStep && typeof rawStep === 'object' ? rawStep as Record<string, unknown> : {};
      const content = String(step.content || '').trim();
      if (!content) return null;
      const label = String(step.label || '').replace(/\s+/g, ' ').trim();
      const delaySeconds = Number(step.delay_seconds);
      return {
        label: label || `Step ${index + 1}`,
        content,
        send_mode: normalizeModernSendMode(step.send_mode),
        media_source: normalizeMediaSource(step.media_source),
        status_background_color: normalizeStatusBackgroundColor(step.status_background_color),
        status_font: normalizeStatusFont(step.status_font),
        delay_seconds: Number.isFinite(delaySeconds)
          ? Math.min(Math.max(Math.floor(delaySeconds), 0), 3600)
          : 0,
        active: step.active !== false
      };
    })
    .filter(Boolean);
};

const extractVariablesFromTemplate = (payload: Record<string, unknown>) => {
  const variables = new Set<string>(extractVariables(String(payload.content || '')));
  for (const step of normalizeTemplateSequenceSteps(payload.sequence_steps)) {
    for (const variable of extractVariables(String((step as { content?: string }).content || ''))) {
      variables.add(variable);
    }
  }
  return Array.from(variables);
};

const normalizeTemplatePayload = (payload: Record<string, unknown>) => {
  const next = { ...payload } as Record<string, unknown> & {
    send_mode?:
      | 'auto_media'
      | 'media_only'
      | 'text_preview'
      | 'text_only'
      | 'image'
      | 'image_only'
      | 'link_preview';
    send_images?: boolean;
    media_source?: unknown;
    sequence_steps?: unknown;
  };
  next.sequence_steps = normalizeTemplateSequenceSteps(payload.sequence_steps);
  next.media_source = normalizeMediaSource(payload.media_source);
  next.status_background_color = normalizeStatusBackgroundColor(payload.status_background_color);
  next.status_font = normalizeStatusFont(payload.status_font);

  const explicitMode = next.send_mode;

  if (explicitMode === 'auto_media' || explicitMode === 'image') {
    next.send_mode = 'auto_media';
    next.send_images = true;
    return next;
  }

  if (explicitMode === 'media_only' || explicitMode === 'image_only') {
    next.send_mode = 'media_only';
    next.send_images = true;
    return next;
  }

  if (explicitMode === 'text_preview' || explicitMode === 'link_preview') {
    next.send_mode = 'text_preview';
    next.send_images = false;
    return next;
  }

  if (explicitMode === 'text_only') {
    next.send_mode = 'text_only';
    next.send_images = false;
    return next;
  }

  const defaultMode = next.send_images === false ? 'text_preview' : 'auto_media';
  next.send_mode = defaultMode;
  next.send_images = defaultMode === 'auto_media';
  return next;
};

const normalizeTemplateResponse = <T extends Record<string, unknown>>(template: T): T => {
  const next = { ...template } as T & {
    send_mode?: 'auto_media' | 'text_preview' | 'text_only' | 'media_only' | 'image' | 'image_only' | 'link_preview' | null;
    send_images?: boolean | null;
    media_source?: unknown;
    sequence_steps?: unknown;
    status_background_color?: unknown;
    status_font?: unknown;
  };

  if (next.send_mode === 'image' && next.send_images === false) {
    next.send_mode = 'text_preview';
  }

  if (next.send_mode === 'image') next.send_mode = 'auto_media';
  if (next.send_mode === 'image_only') next.send_mode = 'media_only';
  if (next.send_mode === 'link_preview') next.send_mode = 'text_preview';

  if (next.send_mode === 'auto_media' || next.send_mode === 'media_only') {
    next.send_images = true;
  } else if (next.send_mode === 'text_preview' || next.send_mode === 'text_only') {
    next.send_images = false;
  }

  next.media_source = normalizeMediaSource(next.media_source);
  next.sequence_steps = normalizeTemplateSequenceSteps(next.sequence_steps);
  next.status_background_color = normalizeStatusBackgroundColor(next.status_background_color);
  next.status_font = normalizeStatusFont(next.status_font);

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
      const variables = extractVariablesFromTemplate(payload);
      
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
      const variables = extractVariablesFromTemplate(payload);
      
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
        { name: 'image_url', description: 'Article image URL when present' },
        { name: 'media_url', description: 'Article media URL when present' },
        { name: 'media_kind', description: 'Article media type (image, video, audio, or document)' },
        { name: 'media_mime', description: 'Detected media MIME type when known' },
        { name: 'media_filename', description: 'Detected media filename when known' },
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
module.exports.__testUtils = {
  extractVariables,
  normalizeTemplateSequenceSteps,
  normalizeStatusBackgroundColor,
  normalizeStatusFont,
  normalizeTemplatePayload,
  normalizeTemplateResponse
};
