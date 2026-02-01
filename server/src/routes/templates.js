const express = require('express');
const { supabase } = require('../db/supabase');

// Extract variable names from template content (e.g., {{title}}, {{description}})
function extractVariables(content) {
  const regex = /\{\{(\w+)\}\}/g;
  const variables = new Set();
  let match;
  while ((match = regex.exec(content)) !== null) {
    variables.add(match[1]);
  }
  return Array.from(variables);
}

const templateRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const { data: templates, error } = await supabase
        .from('templates')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json(templates);
    } catch (error) {
      console.error('Error fetching templates:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      // Extract variables from template content
      const variables = extractVariables(req.body.content || '');
      
      const { data: template, error } = await supabase
        .from('templates')
        .insert({ ...req.body, variables })
        .select()
        .single();
      
      if (error) throw error;
      res.json(template);
    } catch (error) {
      console.error('Error creating template:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      // Extract variables from template content
      const variables = extractVariables(req.body.content || '');
      
      const { data: template, error } = await supabase
        .from('templates')
        .update({ ...req.body, variables })
        .eq('id', req.params.id)
        .select()
        .single();
      
      if (error) throw error;
      res.json(template);
    } catch (error) {
      console.error('Error updating template:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const { error } = await supabase
        .from('templates')
        .delete()
        .eq('id', req.params.id);
      
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting template:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get available variables for templates based on feed items
  router.get('/available-variables', async (_req, res) => {
    try {
      // Get recent feed items to extract available fields
      const { data: items, error } = await supabase
        .from('feed_items')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      
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
        { name: 'categories', description: 'Article categories' }
      ];
      
      // Extract additional fields from raw_data
      const additionalFields = new Set();
      items.forEach(item => {
        if (item.raw_data && typeof item.raw_data === 'object') {
          Object.keys(item.raw_data).forEach(key => {
            if (!standardFields.find(f => f.name === key)) {
              additionalFields.add(key);
            }
          });
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
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = templateRoutes;
