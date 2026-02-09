'use client';

import React, { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Feed, FeedItem, Template } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Layers, Pencil, Trash2, Eye, Loader2 } from 'lucide-react';

const schema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  content: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean().default(true),
  send_mode: z.enum(['image', 'image_only', 'link_preview', 'text_only']).default('image')
});

type TemplateFormValues = z.infer<typeof schema>;

const applyTemplate = (content: string, data: Record<string, unknown>) => {
  if (!content || !data) return content;
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = data[key];
    if (value === undefined || value === null) return `{{${key}}}`;
    return String(value);
  });
};

const escapeHtml = (value: string) => {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const formatWhatsAppMarkdown = (text: string) => {
  if (!text) return '';
  const safe = escapeHtml(text);
  return safe
    .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/~(.*?)~/g, '<del>$1</del>')
    .replace(/```([\s\S]*?)```/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
};

const TemplatesPage = () => {
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [sampleFeedId, setSampleFeedId] = useState<string>('__all');
  const { data: feeds = [] } = useQuery<Feed[]>({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const { data: templates = [] } = useQuery<Template[]>({ queryKey: ['templates'], queryFn: () => api.get('/api/templates') });
  const { data: availableVariables = [] } = useQuery<Array<{ name: string }>>({
    queryKey: ['available-variables', sampleFeedId],
    queryFn: () =>
      sampleFeedId === '__all'
        ? api.get('/api/templates/available-variables')
        : api.get(`/api/templates/available-variables?feed_id=${encodeURIComponent(sampleFeedId)}`)
  });
  const { data: feedItems = [] } = useQuery<FeedItem[]>({
    queryKey: ['feed-items', sampleFeedId],
    queryFn: () =>
      sampleFeedId === '__all'
        ? api.get('/api/feed-items')
        : api.get(`/api/feed-items/by-feed/${encodeURIComponent(sampleFeedId)}`)
  });
  const [active, setActive] = useState<Template | null>(null);
  const [previewWithData, setPreviewWithData] = useState(true);

  const resolveSendMode = (template?: Template | null): 'image' | 'image_only' | 'link_preview' | 'text_only' => {
    if (template?.send_mode === 'image_only') return 'image_only';
    if (template?.send_mode === 'image' && template?.send_images === false) return 'image_only';
    if (template?.send_mode === 'link_preview') return 'link_preview';
    if (template?.send_mode === 'text_only') return 'text_only';
    return 'image';
  };

  const sampleData = feedItems[0]
    ? {
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
    }
    : {
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

  const form = useForm<TemplateFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { id: undefined, name: '', content: '', description: '', active: true, send_mode: 'image' }
  });

  const watchedContent = useWatch({ control: form.control, name: 'content' });
  const watchedSendMode = useWatch({ control: form.control, name: 'send_mode' });

  const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error');

  useEffect(() => {
    if (active) {
      form.reset({
        id: active.id,
        name: active.name,
        content: active.content,
        description: active.description || '',
        active: active.active ?? true,
        send_mode: resolveSendMode(active)
      });
    }
  }, [active, form]);

  const saveTemplate = useMutation({
    mutationFn: (payload: TemplateFormValues) => {
      const { id, ...body } = payload;
      const resolvedId = id || active?.id;
      return resolvedId ? api.put(`/api/templates/${resolvedId}`, body) : api.post('/api/templates', body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setActive(null);
      form.reset({ id: undefined, name: '', content: '', description: '', active: true, send_mode: 'image' });
    },
    onError: (error: unknown) => alert(`Failed to save template: ${getErrorMessage(error)}`)
  });

  const deleteTemplate = useMutation({
    mutationFn: (id: string) => api.delete(`/api/templates/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
      if (active?.id === id) {
        setActive(null);
        form.reset({ id: undefined, name: '', content: '', description: '', active: true, send_mode: 'image' });
      }
    },
    onError: (error: unknown) => alert(`Failed to delete template: ${getErrorMessage(error)}`)
  });

  const onSubmit = (values: TemplateFormValues) => {
    saveTemplate.mutate({
      id: values.id,
      name: values.name,
      content: values.content,
      description: values.description,
      active: values.active,
      send_mode: values.send_mode
    });
  };

  const insertVariable = (varName: string) => {
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
              <CardDescription>Write regular WhatsApp text. Insert feed fields with the chips below.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Template Name</Label>
                  <Input id="name" {...form.register('name')} placeholder="Breaking News Template" />
                </div>

                <div className="space-y-2">
                  <Label>Sample Feed (for variables + preview)</Label>
                  <Select value={sampleFeedId} onValueChange={setSampleFeedId}>
                    <SelectTrigger>
                      <SelectValue placeholder="All feeds" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all">All feeds</SelectItem>
                      {feeds.map((feed) => (
                        <SelectItem key={feed.id} value={feed.id}>
                          {feed.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="content">Content</Label>
                  <Textarea
                    id="content"
                    {...form.register('content')}
                    ref={(element) => {
                      form.register('content').ref(element);
                      textareaRef.current = element;
                    }}
                    placeholder="Start typing your message"
                    className="min-h-[120px] text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Put your cursor anywhere, then tap a variable chip to insert it.
                  </p>
                </div>

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
                          className="text-xs"
                        >
                          {variable.name.replace(/_/g, ' ')}
                        </Button>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No feed fields yet. Add a feed and check it once to load fields.
                      </p>
                    )}
                  </div>
                </div>


                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Input id="description" {...form.register('description')} placeholder="Template for daily news updates" />
                </div>

                <input type="hidden" {...form.register('id')} />

                <div className="space-y-4 rounded-lg border p-4">
                  <Controller
                    control={form.control}
                    name="send_mode"
                    render={({ field }) => (
                      <div className="space-y-3">
                        <Label>Message Format</Label>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          {[
                            { value: 'image', label: 'Image + Text', icon: '🖼️' },
                            { value: 'image_only', label: 'Image Only', icon: '📷' },
                            { value: 'link_preview', label: 'Text + Link Preview', icon: '🔗' },
                            { value: 'text_only', label: 'Text Only', icon: '📝' },
                          ].map((mode) => (
                            <div
                              key={mode.value}
                              onClick={() => field.onChange(mode.value)}
                              className={`cursor-pointer rounded-lg border p-3 text-center transition-all hover:bg-accent ${field.value === mode.value
                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                : 'bg-background'
                                }`}
                            >
                              <div className="mb-1 text-2xl">{mode.icon}</div>
                              <div className="text-xs font-medium">{mode.label}</div>
                            </div>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {field.value === 'image' && 'Sends an image with your template text under it.'}
                          {field.value === 'image_only' && 'Sends image only. Template text is kept for fallback if image fails.'}
                          {field.value === 'link_preview' && 'Sends text and ensures a link preview is included.'}
                          {field.value === 'text_only' && 'Sends plain text only (no media, no preview).'}
                        </p>
                      </div>
                    )}
                  />

                  <div className="flex items-center gap-4 border-t pt-4">
                    <Controller
                      control={form.control}
                      name="active"
                      render={({ field }) => (
                        <div className="flex items-center gap-2">
                          <Switch
                            id="active"
                            checked={field.value}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                          />
                          <div>
                            <Label htmlFor="active" className="cursor-pointer font-medium">
                              Enabled
                            </Label>
                            <p className="text-[0.7rem] text-muted-foreground">
                              Keep this template available for automations
                            </p>
                          </div>
                        </div>
                      )}
                    />
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button type="submit" disabled={saveTemplate.isPending}>
                    {saveTemplate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {active ? 'Update Template' : 'Save Template'}
                  </Button>
                  {active && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setActive(null);
                        form.reset({ id: undefined, name: '', content: '', description: '', active: true, send_mode: 'image' });
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>

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
              <div className="rounded-lg bg-emerald-50/70 p-4 dark:bg-emerald-950/40">
                <div className="max-w-[85%] rounded-lg bg-white/80 px-3 py-2 shadow-sm ring-1 ring-emerald-200/60 dark:bg-emerald-900/50 dark:ring-emerald-800/60">
                  {previewWithData && (watchedSendMode === 'image' || watchedSendMode === 'image_only') && sampleData.image_url ? (
                    <div className="mb-2 overflow-hidden rounded-md border border-black/5 bg-white">
                      <Image
                        src={sampleData.image_url}
                        alt="Template preview"
                        width={640}
                        height={360}
                        unoptimized
                        loader={({ src }) => src}
                        className="block h-40 w-full object-cover"
                      />
                    </div>
                  ) : null}
                  <div
                    className="text-sm text-foreground/90 whitespace-pre-wrap [&_strong]:font-bold [&_em]:italic [&_del]:line-through [&_code]:bg-muted [&_code]:px-1 [&_code]:rounded [&_code]:font-mono"
                    dangerouslySetInnerHTML={{
                      __html: formatWhatsAppMarkdown(
                        previewWithData
                          ? (() => {
                            const base = applyTemplate(watchedContent || '', sampleData);
                            if (watchedSendMode !== 'link_preview') return base;
                            const link = String(sampleData.link || sampleData.url || '').trim();
                            if (!link || /https?:\/\//i.test(base)) return base;
                            return `${base}\n${link}`.trim();
                          })()
                          : watchedContent || 'Start typing to preview...'
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
                  Using data from: &quot;{feedItems[0].title?.slice(0, 40)}...&quot;
                </p>
              )}
            </CardContent>
          </Card>
        </div>

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
                <p className="text-center text-muted-foreground py-8">No templates yet. Create one above.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default TemplatesPage;
