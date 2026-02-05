import React, { useEffect, useState, useRef } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Checkbox } from '../components/ui/checkbox';
import { Switch } from '../components/ui/switch';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Label } from '../components/ui/label';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';
import { Layers, Pencil, Trash2, Eye, Loader2 } from 'lucide-react';

const schema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean().default(true),
  send_images: z.boolean().default(true)
});

const applyTemplate = (content, data) => {
  if (!content || !data) return content;
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = data[key];
    if (value === undefined || value === null) return `{{${key}}}`;
    return String(value);
  });
};

const escapeHtml = (value) => {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const formatWhatsAppMarkdown = (text) => {
  if (!text) return '';
  const safe = escapeHtml(text);
  return safe
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
  const { data: feedItems = [] } = useQuery({ 
    queryKey: ['feed-items'], 
    queryFn: () => api.get('/api/feed-items') 
  });
  const feedId = feedItems[0]?.feed_id;
  const { data: availableVariables = [] } = useQuery({ 
    queryKey: ['available-variables', feedId], 
    queryFn: () => api.get(`/api/templates/available-variables${feedId ? `?feed_id=${feedId}` : ''}`) 
  });
  const [active, setActive] = useState(null);
  const [previewWithData, setPreviewWithData] = useState(true);
  
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
    defaultValues: { name: '', content: '', description: '', active: true, send_images: true }
  });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        content: active.content,
        description: active.description || '',
        active: active.active ?? true,
        send_images: active.send_images ?? true
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
    },
    onError: (error) => alert(`Failed to save template: ${error?.message || 'Unknown error'}`)
  });

  const deleteTemplate = useMutation({
    mutationFn: (id) => api.delete(`/api/templates/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
      if (active?.id === id) {
        setActive(null);
        form.reset({ name: '', content: '', description: '', active: true });
      }
    },
    onError: (error) => alert(`Failed to delete template: ${error?.message || 'Unknown error'}`)
  });

  const onSubmit = (values) => {
    saveTemplate.mutate({
      name: values.name,
      content: values.content,
      description: values.description,
      active: values.active,
      send_images: values.send_images
    });
  };

  const insertVariable = (varName) => {
    const textarea = textareaRef.current;
    const currentContent = form.getValues('content') || '';
    
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent = currentContent.slice(0, start) + `{{${varName}}}` + currentContent.slice(end);
      form.setValue('content', newContent);
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
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
        <p className="text-muted-foreground">Compose WhatsApp messages with markdown and variables.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                {active ? 'Edit Template' : 'Create Template'}
              </CardTitle>
              <CardDescription>
                Use *bold*, _italic_, ~strikethrough~. Variables: {'{{variable}}'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Template Name</Label>
                  <Input id="name" {...form.register('name')} placeholder="Breaking News Template" />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="content">Content</Label>
                  <Textarea 
                    id="content"
                    {...form.register('content')} 
                    ref={(e) => {
                      form.register('content').ref(e);
                      textareaRef.current = e;
                    }}
                    placeholder="*{{title}}*&#10;&#10;{{link}}" 
                    className="min-h-[120px] font-mono text-sm"
                  />
                </div>
                
                {/* Available Variables */}
                <div className="space-y-2">
                  <Label>Available Variables (click to insert)</Label>
                  <div className="flex flex-wrap gap-2 rounded-lg border p-3">
                    {availableVariables.length > 0 ? (
                      availableVariables.map((variable) => (
                        <Button
                          key={variable.name}
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => insertVariable(variable.name)}
                          className="font-mono text-xs"
                        >
                          {`{{${variable.name}}}`}
                        </Button>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No feed items yet. Add a feed and fetch items to see variables.
                      </p>
                    )}
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Input id="description" {...form.register('description')} placeholder="Template for daily news updates" />
                </div>
                
                <Controller
                  control={form.control}
                  name="active"
                  render={({ field }) => (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="active"
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      <Label htmlFor="active" className="cursor-pointer">Active</Label>
                    </div>
                  )}
                />
                
                <Controller
                  control={form.control}
                  name="send_images"
                  render={({ field }) => (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="send_images"
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      <Label htmlFor="send_images" className="cursor-pointer">Send Images with Message</Label>
                    </div>
                  )}
                />
                
                <div className="flex gap-2">
                  <Button type="submit" disabled={saveTemplate.isPending}>
                    {saveTemplate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {active ? 'Update Template' : 'Save Template'}
                  </Button>
                  {active && (
                    <Button type="button" variant="outline" onClick={() => { setActive(null); form.reset({ name: '', content: '', description: '', active: true, send_images: true }); }}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Live Preview */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Eye className="h-5 w-5" />
                  Live Preview
                </CardTitle>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={previewWithData}
                    onCheckedChange={(checked) => setPreviewWithData(checked === true)}
                  />
                  <span className="text-muted-foreground">Show with sample data</span>
                </label>
              </div>
            </CardHeader>
            <CardContent>
              {/* WhatsApp-style preview */}
              <div className="rounded-lg bg-emerald-50/70 p-4 dark:bg-emerald-950/40">
                <div className="max-w-[85%] rounded-lg bg-white/80 px-3 py-2 shadow-sm ring-1 ring-emerald-200/60 dark:bg-emerald-900/50 dark:ring-emerald-800/60">
                  <div
                    className="text-sm text-foreground/90 whitespace-pre-wrap"
                    dangerouslySetInnerHTML={{
                      __html: formatWhatsAppMarkdown(
                        previewWithData 
                          ? applyTemplate(form.watch('content') || '', sampleData)
                          : (form.watch('content') || 'Start typing to preview...')
                      )
                    }}
                  />
                  <div className="text-right mt-1">
                    <span className="text-[10px] text-muted-foreground">12:00 PM</span>
                  </div>
                </div>
              </div>
              
              {previewWithData && feedItems[0] && (
                <p className="text-xs text-muted-foreground mt-2">
                  Using data from: "{feedItems[0].title?.slice(0, 40)}..."
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Saved Templates */}
        <Card>
          <CardHeader>
            <CardTitle>Saved Templates</CardTitle>
            <CardDescription>{templates.length} template{templates.length !== 1 ? 's' : ''}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {templates.map((template) => (
                <div key={template.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{template.name}</p>
                      {template.description && (
                        <p className="text-xs text-muted-foreground truncate">{template.description}</p>
                      )}
                    </div>
                    <Badge variant={template.active ? 'success' : 'secondary'}>
                      {template.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setActive(template)}>
                      <Pencil className="mr-1 h-3 w-3" /> Edit
                    </Button>
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      onClick={() => deleteTemplate.mutate(template.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
              {templates.length === 0 && (
                <p className="text-center text-muted-foreground py-8">
                  No templates yet. Create one above.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default TemplatesPage;
