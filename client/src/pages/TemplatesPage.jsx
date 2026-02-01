import React, { useEffect, useState, useRef } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';

const schema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean().default(true)
});

// Apply template variables to content
const applyTemplate = (content, data) => {
  if (!content || !data) return content;
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = data[key];
    if (value === undefined || value === null) return `{{${key}}}`;
    return String(value);
  });
};

// Convert WhatsApp markdown to HTML-safe preview
const formatWhatsAppMarkdown = (text) => {
  if (!text) return '';
  return text
    .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/~(.*?)~/g, '<del>$1</del>')
    .replace(/```(.*?)```/gs, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
};

const TemplatesPage = () => {
  const queryClient = useQueryClient();
  const textareaRef = useRef(null);
  const { data: templates = [] } = useQuery({ queryKey: ['templates'], queryFn: () => api.get('/api/templates') });
  const { data: availableVariables = [] } = useQuery({ 
    queryKey: ['available-variables'], 
    queryFn: () => api.get('/api/templates/available-variables') 
  });
  const { data: feedItems = [] } = useQuery({ 
    queryKey: ['feed-items'], 
    queryFn: () => api.get('/api/feed-items') 
  });
  const [active, setActive] = useState(null);
  const [previewWithData, setPreviewWithData] = useState(true);
  
  // Get sample data from first feed item for preview
  const sampleData = feedItems[0] ? {
    title: feedItems[0].title || 'Sample Title',
    description: feedItems[0].description || 'Sample description text',
    content: feedItems[0].content || feedItems[0].description || 'Full content here',
    link: feedItems[0].link || 'https://example.com/article',
    url: feedItems[0].link || 'https://example.com/article',
    author: feedItems[0].author || 'Author Name',
    pub_date: feedItems[0].pub_date || new Date().toISOString(),
    image_url: feedItems[0].image_url || '',
    imageUrl: feedItems[0].image_url || '',
    categories: feedItems[0].categories || 'News'
  } : {
    title: 'Sample Article Title',
    description: 'This is a sample description for preview purposes.',
    content: 'Full article content would appear here.',
    link: 'https://example.com/article',
    url: 'https://example.com/article',
    author: 'John Doe',
    pub_date: new Date().toISOString(),
    image_url: '',
    imageUrl: '',
    categories: 'News, Technology'
  };

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: '', content: '', description: '', active: true }
  });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        content: active.content,
        description: active.description || '',
        active: active.active ?? true
      });
    }
  }, [active, form]);

  const saveTemplate = useMutation({
    mutationFn: (payload) =>
      active ? api.put(`/api/templates/${active.id}`, payload) : api.post('/api/templates', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setActive(null);
      form.reset();
    }
  });

  const deleteTemplate = useMutation({
    mutationFn: (id) => api.delete(`/api/templates/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['templates'] })
  });

  const onSubmit = (values) => {
    const payload = {
      name: values.name,
      content: values.content,
      description: values.description,
      active: values.active
    };
    saveTemplate.mutate(payload);
  };

  const insertVariable = (varName) => {
    const textarea = textareaRef.current;
    const currentContent = form.getValues('content') || '';
    
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent = currentContent.slice(0, start) + `{{${varName}}}` + currentContent.slice(end);
      form.setValue('content', newContent);
      // Reset cursor position after insertion
      setTimeout(() => {
        textarea.focus();
        const newPos = start + varName.length + 4;
        textarea.setSelectionRange(newPos, newPos);
      }, 0);
    } else {
      form.setValue('content', `${currentContent}{{${varName}}}`);
    }
  };

  return (
    <div className="space-y-8">
      <PageHeader title="Templates" subtitle="Compose WhatsApp-ready messages with markdown and variables." />

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{active ? 'Edit Template' : 'Create Template'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Template name</label>
                <Input {...form.register('name')} placeholder="Breaking News Template" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Content (WhatsApp markdown supported)</label>
                <Textarea 
                  {...form.register('content')} 
                  ref={(e) => {
                    form.register('content').ref(e);
                    textareaRef.current = e;
                  }}
                  placeholder="*{{title}}*&#10;{{link}}" 
                  rows={6} 
                />
                <p className="text-xs text-muted-foreground">
                  Use *bold*, _italic_, ~strikethrough~. Variables: {'{{variable}}'}
                </p>
              </div>
              
              {/* Available Variables Section */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Available Variables (click to insert)</label>
                <div className="flex flex-wrap gap-2 rounded-lg border border-ink/10 bg-white/50 p-3">
                  {availableVariables.length > 0 ? (
                    availableVariables.map((variable) => (
                      <button
                        key={variable.name}
                        type="button"
                        onClick={() => insertVariable(variable.name)}
                        className="rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-700 hover:bg-sky-200 transition-colors"
                        title={variable.description}
                      >
                        {`{{${variable.name}}}`}
                      </button>
                    ))
                  ) : (
                    <p className="text-sm text-ink/50">
                      No feed items yet. Add a feed and fetch items to see available variables.
                    </p>
                  )}
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-sm font-medium">Description (optional)</label>
                <Input {...form.register('description')} placeholder="Template for daily news updates" />
              </div>
              <Controller
                control={form.control}
                name="active"
                render={({ field }) => (
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
                    Active
                  </label>
                )}
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={saveTemplate.isPending}>
                  {active ? 'Update Template' : 'Save Template'}
                </Button>
                {active && (
                  <Button type="button" variant="outline" onClick={() => setActive(null)}>
                    Clear
                  </Button>
                )}
              </div>
            </form>
            {/* Live Preview Section */}
            <div className="rounded-2xl border border-border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Live Preview
                </p>
                <label className="flex items-center gap-2 text-xs">
                  <input 
                    type="checkbox" 
                    checked={previewWithData} 
                    onChange={(e) => setPreviewWithData(e.target.checked)}
                    className="rounded border-border"
                  />
                  <span className="text-muted-foreground">Show with sample data</span>
                </label>
              </div>
              
              {/* WhatsApp-style preview */}
              <div className="rounded-lg bg-[#e5ddd5] p-3">
                <div className="max-w-[85%] rounded-lg bg-[#dcf8c6] px-3 py-2 shadow-sm">
                  <div 
                    className="text-sm text-gray-800 whitespace-pre-wrap"
                    dangerouslySetInnerHTML={{
                      __html: formatWhatsAppMarkdown(
                        previewWithData 
                          ? applyTemplate(form.watch('content') || '', sampleData)
                          : (form.watch('content') || 'Start typing to preview...')
                      )
                    }}
                  />
                  <div className="text-right mt-1">
                    <span className="text-[10px] text-gray-500">12:00 PM</span>
                  </div>
                </div>
              </div>
              
              {previewWithData && feedItems[0] && (
                <p className="text-xs text-muted-foreground">
                  Using data from: "{feedItems[0].title?.slice(0, 40)}..."
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Existing Templates</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Active</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>{template.name}</TableCell>
                    <TableCell>{template.active ? 'Yes' : 'No'}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setActive(template)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteTemplate.mutate(template.id)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {templates.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-ink/50">
                      No templates created.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  );
};

export default TemplatesPage;
