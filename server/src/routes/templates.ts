import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { validate, schemas } = require('../middleware/validation');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');
const { normalizeMessageText } = require('../utils/messageText');

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

const templateRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const { data: templates, error } = await getDb()
        .from('templates')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json(templates);
    } catch (error) {
      console.error('Error fetching templates:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/', validate(schemas.template), async (req: Request, res: Response) => {
    try {
      const normalizedContent = normalizeMessageText(req.body.content);
      // Extract variables from template content
      const variables = extractVariables(normalizedContent);
      
      const { data: template, error } = await getDb()
        .from('templates')
        .insert({ ...req.body, content: normalizedContent, variables })
        .select()
        .single();
      
      if (error) throw error;
      res.json(template);
    } catch (error) {
      console.error('Error creating template:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.put('/:id', validate(schemas.template), async (req: Request, res: Response) => {
    try {
      const normalizedContent = normalizeMessageText(req.body.content);
      // Extract variables from template content
      const variables = extractVariables(normalizedContent);
      
      const { data: template, error } = await getDb()
        .from('templates')
        .update({ ...req.body, content: normalizedContent, variables })
        .eq('id', req.params.id)
        .select()
        .single();
      
      if (error) throw error;
      res.json(template);
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
