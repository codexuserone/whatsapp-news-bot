'use client';

import React, { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { buildTemplatePreviewSendPayloads, type TemplatePreviewPayload } from '@/lib/templatePreviewPayload';
import type { BackendSettings, Feed, FeedItem, Target, Template } from '@/lib/types';
import { dedupeTargets, formatTargetLabel, normalizeTargetName } from '@/lib/targetUtils';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Layers, Pencil, Trash2, Eye, Loader2, Send } from 'lucide-react';

const schema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean().default(true),
  send_mode: z.enum(['auto_media', 'media_only', 'text_preview', 'text_only']).default('auto_media'),
  media_source: z.enum(['auto', 'image', 'video']).default('auto'),
  status_background_color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  status_font: z.coerce.number().int().min(0).max(8).nullable().optional(),
  sequence_steps: z.array(z.object({
    label: z.string().optional(),
    content: z.string().min(1),
    send_mode: z.enum(['auto_media', 'media_only', 'text_preview', 'text_only']).default('auto_media'),
    media_source: z.enum(['auto', 'image', 'video']).default('auto'),
    status_background_color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
    status_font: z.coerce.number().int().min(0).max(8).nullable().optional(),
    delay_seconds: z.coerce.number().int().min(0).max(3600).default(0),
    active: z.boolean().default(true)
  })).max(12).default([])
});

type TemplateFormValues = z.infer<typeof schema>;
type TemplateSendMode = TemplateFormValues['send_mode'];
type TemplateMediaSource = TemplateFormValues['sequence_steps'][number]['media_source'];

const WORD_JOINER = '\u2060';
const DEFAULT_STATUS_BACKGROUND = '#0f172a';
const STATUS_BACKGROUND_SWATCHES = ['#0f172a', '#166534', '#7c2d12', '#7e22ce', '#be123c', '#0369a1'];
const STATUS_FONT_OPTIONS = [
  { value: 0, label: 'Default' },
  { value: 1, label: 'Serif' },
  { value: 2, label: 'Norican' },
  { value: 3, label: 'Bryndan Write' },
  { value: 4, label: 'Bebas Neue' },
  { value: 5, label: 'Oswald' },
  { value: 6, label: 'Merriweather' },
  { value: 7, label: 'Roboto' },
  { value: 8, label: 'System' }
];

const escapeWhatsAppFormatting = (value: unknown) => {
  const text = String(value ?? '');
  if (!text) return '';
  return text.replace(/([*_~`])(?!\u2060)/g, `$1${WORD_JOINER}`);
};

const applyTemplate = (content: string, data: Record<string, unknown>) => {
  if (!content || !data) return content;
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = data[key];
    if (value === undefined || value === null) return `{{${key}}}`;
    return escapeWhatsAppFormatting(value);
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
    .replace(/```(?!\u2060)([\s\S]*?)```(?!\u2060)/g, '<code>$1</code>')
    .replace(/\*(?!\u2060)(.*?)\*(?!\u2060)/g, '<strong>$1</strong>')
    .replace(/_(?!\u2060)(.*?)_(?!\u2060)/g, '<em>$1</em>')
    .replace(/~(?!\u2060)(.*?)~(?!\u2060)/g, '<del>$1</del>')
    .replace(/\n/g, '<br/>');
};

const isSafeImageSrc = (value: unknown) => {
  const src = String(value || '').trim();
  if (!src) return false;
  if (src.startsWith('data:image/')) return true;
  if (src.startsWith('/')) return true;
  return src.startsWith('http://') || src.startsWith('https://');
};

const isSafeVideoSrc = (value: unknown) => {
  const src = String(value || '').trim();
  if (!src) return false;
  if (src.startsWith('/')) return true;
  return src.startsWith('http://') || src.startsWith('https://');
};

const getFeedItemMedia = (item?: FeedItem | null) => {
  const mediaUrl = String(item?.media_url || item?.image_url || '').trim();
  const rawKind = String(item?.media_kind || '').trim().toLowerCase();
  const looksLikeVideo = /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(mediaUrl);
  const looksLikeAudio = /\.(mp3|wav|ogg|m4a|flac|aac|opus)(?:[?#]|$)/i.test(mediaUrl);
  const looksLikeDocument = /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|csv|txt|rtf|zip)(?:[?#]|$)/i.test(mediaUrl);
  const mediaKind =
    rawKind === 'video' || looksLikeVideo
      ? 'video'
      : rawKind === 'audio' || looksLikeAudio
        ? 'audio'
        : rawKind === 'document' || looksLikeDocument
          ? 'document'
          : mediaUrl
            ? 'image'
            : '';
  return {
    mediaUrl,
    mediaKind
  };
};

const getTemplateModeLabel = (mode?: Template['send_mode'] | null) => {
  switch (mode) {
    case 'media_only':
      return 'Media only';
    case 'text_preview':
      return 'Text + preview';
    case 'text_only':
      return 'Text only';
    case 'auto_media':
    default:
      return 'Auto media';
  }
};

const getTemplateModeDescription = (mode?: Template['send_mode'] | null) => {
  switch (mode) {
    case 'media_only':
      return 'Send only the story media. If the story has no supported media, sending is blocked.';
    case 'text_preview':
      return 'Send your text and let WhatsApp build a preview from the link in the message.';
    case 'text_only':
      return 'Send plain text only, with no link preview and no media.';
    case 'auto_media':
    default:
      return 'Use the story media when it exists. If not, fall back to text with a preview link.';
  }
};

const resolveTemplateSendMode = (mode: unknown): TemplateSendMode => {
  if (mode === 'media_only' || mode === 'text_preview' || mode === 'text_only' || mode === 'auto_media') {
    return mode;
  }
  return 'auto_media';
};

const resolveTemplateMediaSource = (source: unknown): TemplateMediaSource => {
  if (source === 'image' || source === 'video') return source;
  return 'auto';
};

const selectMediaForSource = (
  data: Record<string, unknown>,
  source: TemplateMediaSource
) => {
  const imageUrl = String(data.image_url || data.imageUrl || '').trim();
  const mediaUrl = String(data.media_url || data.mediaUrl || '').trim();
  const rawKind = String(data.media_kind || data.mediaKind || '').trim().toLowerCase();
  const inferredKind =
    rawKind ||
    (/\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(mediaUrl)
      ? 'video'
      : /\.(mp3|wav|ogg|m4a|flac|aac|opus)(?:[?#]|$)/i.test(mediaUrl)
        ? 'audio'
        : /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|csv|txt|rtf|zip)(?:[?#]|$)/i.test(mediaUrl)
          ? 'document'
          : mediaUrl
            ? 'image'
            : '');

  if (source === 'image') {
    return imageUrl
      ? { mediaUrl: imageUrl, mediaKind: 'image' }
      : inferredKind === 'image'
        ? { mediaUrl, mediaKind: 'image' }
        : { mediaUrl: '', mediaKind: '' };
  }

  if (source === 'video') {
    return inferredKind === 'video'
      ? { mediaUrl, mediaKind: 'video' }
      : { mediaUrl: '', mediaKind: '' };
  }

  return { mediaUrl: mediaUrl || imageUrl, mediaKind: inferredKind || (imageUrl ? 'image' : '') };
};

const getTemplateMediaSourceLabel = (source: unknown) => {
  switch (resolveTemplateMediaSource(source)) {
    case 'image':
      return 'Featured image';
    case 'video':
      return 'Story video';
    case 'auto':
    default:
      return 'Auto media';
  }
};

const resolveStatusBackgroundColor = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_STATUS_BACKGROUND;
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-f]{6}$/i.test(withHash) ? withHash.toLowerCase() : DEFAULT_STATUS_BACKGROUND;
};

const resolveStatusFont = (value: unknown) => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 8 ? parsed : 0;
};

const getStatusPreviewFontFamily = (value: unknown) => {
  switch (resolveStatusFont(value)) {
    case 1:
      return 'Georgia, serif';
    case 2:
    case 3:
      return '"Brush Script MT", cursive';
    case 4:
    case 5:
      return '"Arial Narrow", Arial, sans-serif';
    case 6:
      return 'Merriweather, Georgia, serif';
    case 7:
    case 8:
      return 'Roboto, Arial, sans-serif';
    case 0:
    default:
      return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  }
};

const getTemplateSequenceSteps = (template?: Template | null): TemplateFormValues['sequence_steps'] =>
  Array.isArray(template?.sequence_steps)
    ? template.sequence_steps
        .map((step, index) => ({
          label: String(step.label || `Step ${index + 1}`),
          content: String(step.content || ''),
          send_mode: resolveTemplateSendMode(step.send_mode),
          media_source: resolveTemplateMediaSource(step.media_source),
          status_background_color: resolveStatusBackgroundColor(step.status_background_color || template.status_background_color),
          status_font: resolveStatusFont(step.status_font ?? template.status_font),
          delay_seconds: Number(step.delay_seconds || 0),
          active: step.active !== false
        }))
        .filter((step) => step.content.trim())
    : [];

const TemplatesPage = () => {
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [sampleFeedId, setSampleFeedId] = useState<string>('__all');
  const [sampleItemKey, setSampleItemKey] = useState<'latest' | 'with_image' | 'with_video' | 'no_media' | 'long_title' | 'blank'>('latest');
  const [previewTargetKey, setPreviewTargetKey] = useState<string>('');
  const [previewSendNotice, setPreviewSendNotice] = useState<string>('');
  const { data: feeds = [] } = useQuery<Feed[]>({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const { data: targets = [] } = useQuery<Target[]>({ queryKey: ['targets'], queryFn: () => api.get('/api/targets') });
  const { data: templates = [] } = useQuery<Template[]>({ queryKey: ['templates'], queryFn: () => api.get('/api/templates') });
  const { data: settings } = useQuery<BackendSettings>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });
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
        ? api.get('/api/feed-items?scope=all&include_raw_data=true')
        : api.get(`/api/feed-items/by-feed/${encodeURIComponent(sampleFeedId)}`)
  });
  const [active, setActive] = useState<Template | null>(null);
  const [previewWithData, setPreviewWithData] = useState(true);
  const activeTargets = React.useMemo(() => {
    return dedupeTargets(targets, { activeOnly: true });
  }, [targets]);
  const previewTargets = React.useMemo(() => {
    const byKey = new Map<string, Target>();
    for (const target of activeTargets) {
      const type = String(target.type || '').trim().toLowerCase();
      const phone = String(target.phone_number || '').trim().toLowerCase();
      const key = `${type}:${phone}`;
      if (!target.id || !phone || byKey.has(key)) continue;
      const cleanedName = normalizeTargetName(target.name, target.type, phone);
      if (target.type === 'channel' && !cleanedName) continue;
      byKey.set(key, {
        ...target,
        name: cleanedName || target.name || phone
      });
    }
    return Array.from(byKey.values());
  }, [activeTargets]);
  const previewTargetByKey = React.useMemo(() => {
    const map = new Map<string, Target>();
    for (const target of previewTargets) {
      const key = `${target.type}:${target.phone_number}`;
      map.set(key, target);
    }
    return map;
  }, [previewTargets]);

  React.useEffect(() => {
    if (!previewTargetKey) return;
    if (!previewTargetByKey.has(previewTargetKey)) setPreviewTargetKey('');
  }, [previewTargetByKey, previewTargetKey]);

  const selectedPreviewTarget = previewTargetByKey.get(previewTargetKey) || null;
  const statusPreviewAudience = React.useMemo(
    () =>
      String(settings?.status_test_audience_jids || '')
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    [settings?.status_test_audience_jids]
  );

  const resolveSendMode = (template?: Template | null): TemplateSendMode => {
    if (template?.send_mode === 'media_only') return 'media_only';
    if (template?.send_mode === 'auto_media' && template?.send_images === false) return 'text_preview';
    if (template?.send_mode === 'text_preview') return 'text_preview';
    if (template?.send_mode === 'text_only') return 'text_only';
    return 'auto_media';
  };

  const sampleItem = React.useMemo(() => {
    const items = Array.isArray(feedItems) ? feedItems : [];
    if (sampleItemKey === 'blank') return null;
    if (!items.length) return null;

    const latest = items[0] || null;
    const withImage = items.find((item) => getFeedItemMedia(item).mediaKind === 'image') || null;
    const withVideo = items.find((item) => getFeedItemMedia(item).mediaKind === 'video') || null;
    const noMedia = items.find((item) => !getFeedItemMedia(item).mediaUrl) || null;
    const longTitle =
      items.reduce((best, item) => {
        const bestLen = String(best?.title || '').length;
        const nextLen = String(item?.title || '').length;
        return nextLen > bestLen ? item : best;
      }, latest as FeedItem | null) || null;

    switch (sampleItemKey) {
      case 'with_image':
        return withImage || latest;
      case 'with_video':
        return withVideo || latest;
      case 'no_media':
        return noMedia || latest;
      case 'long_title':
        return longTitle || latest;
      case 'latest':
      default:
        return latest;
    }
  }, [feedItems, sampleItemKey]);

  const sampleData = React.useMemo(() => {
    const fallback = {
      title: 'Sample Article Title',
      description: 'This is a sample description for preview purposes.',
      content: 'Full article content would appear here.',
      link: 'https://example.com/article',
      url: 'https://example.com/article',
      author: 'John Doe',
      pub_date: new Date().toISOString(),
      image_url: '',
      imageUrl: '',
      media_url: '',
      mediaUrl: '',
      media_kind: '',
      mediaKind: '',
      categories: 'News, Technology'
    };

    if (sampleItemKey === 'blank') {
      return {
        ...fallback,
        title: '',
        description: '',
        content: '',
        link: '',
        url: '',
        author: '',
        categories: ''
      };
    }

    if (!sampleItem) return fallback;

    const rawData =
      sampleItem.raw_data && typeof sampleItem.raw_data === 'object'
        ? (sampleItem.raw_data as Record<string, unknown>)
        : null;
    const sampleMedia = getFeedItemMedia(sampleItem);
    const rawExtras = rawData
      ? Object.fromEntries(
          Object.entries(rawData).map(([key, value]) => {
            if (value == null) return [key, ''];
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
              return [key, value];
            }
            try {
              return [key, JSON.stringify(value)];
            } catch {
              return [key, String(value)];
            }
          })
        )
      : {};

    const categories =
      Array.isArray(sampleItem.categories)
        ? sampleItem.categories.filter(Boolean).join(', ')
        : String(sampleItem.categories || '').trim();

    return {
      title: sampleItem.title || fallback.title,
      description: sampleItem.description || fallback.description,
      content: sampleItem.content || sampleItem.description || fallback.content,
      link: sampleItem.link || fallback.link,
      url: sampleItem.link || fallback.url,
      author: sampleItem.author || fallback.author,
      pub_date: sampleItem.pub_date || fallback.pub_date,
      image_url: sampleItem.image_url || '',
      imageUrl: sampleItem.image_url || '',
      media_url: sampleMedia.mediaUrl || '',
      mediaUrl: sampleMedia.mediaUrl || '',
      media_kind: sampleMedia.mediaKind || '',
      mediaKind: sampleMedia.mediaKind || '',
      categories: categories || fallback.categories,
      ...rawExtras
    };
  }, [sampleItem, sampleItemKey]);

  const form = useForm<TemplateFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      content: '',
      description: '',
      active: true,
      send_mode: 'auto_media',
      media_source: 'auto',
      status_background_color: DEFAULT_STATUS_BACKGROUND,
      status_font: 0,
      sequence_steps: []
    }
  });

  const watchedContent = useWatch({ control: form.control, name: 'content' });
  const watchedActive = useWatch({ control: form.control, name: 'active' });
  const watchedSendMode = useWatch({ control: form.control, name: 'send_mode' });
  const watchedMediaSource = useWatch({ control: form.control, name: 'media_source' });
  const watchedStatusBackgroundColor = useWatch({ control: form.control, name: 'status_background_color' });
  const watchedStatusFont = useWatch({ control: form.control, name: 'status_font' });
  const watchedSequenceSteps = useWatch({ control: form.control, name: 'sequence_steps' }) || [];
  const selectedTemplateMedia = React.useMemo(
    () => selectMediaForSource(sampleData, resolveTemplateMediaSource(watchedMediaSource)),
    [sampleData, watchedMediaSource]
  );

  const renderedPreviewText = previewWithData
    ? (() => {
      const base = applyTemplate(watchedContent || '', sampleData);
      if (watchedSendMode !== 'text_preview') return base;
      const link = String(sampleData.link || sampleData.url || '').trim();
      if (!link || /https?:\/\//i.test(base)) return base;
      return `${base}\n${link}`.trim();
    })()
    : watchedContent || 'Start typing to preview...';

  const renderedSequencePreviewSteps = watchedSequenceSteps
    .filter((step) => step.active !== false && String(step.content || '').trim())
    .map((step, index) => {
      const sendMode = resolveTemplateSendMode(step.send_mode);
      const base = previewWithData ? applyTemplate(step.content || '', sampleData) : step.content || '';
      const link = String(sampleData.link || sampleData.url || '').trim();
      const renderedText =
        sendMode === 'text_preview' && link && !/https?:\/\//i.test(base)
          ? `${base}\n${link}`.trim()
          : base;
      return {
        index,
        label: String(step.label || `Step ${index + 1}`).trim() || `Step ${index + 1}`,
        sendMode,
        mediaSource: resolveTemplateMediaSource(step.media_source),
        renderedText: renderedText || 'Empty step',
        delaySeconds: Math.max(0, Math.min(3600, Number(step.delay_seconds || 0))),
        backgroundColor: resolveStatusBackgroundColor(step.status_background_color || watchedStatusBackgroundColor),
        font: resolveStatusFont(step.status_font ?? watchedStatusFont)
      };
    });

  const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error');

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        content: active.content,
        description: active.description || '',
        active: active.active ?? true,
        send_mode: resolveSendMode(active),
        media_source: resolveTemplateMediaSource(active.media_source),
        status_background_color: resolveStatusBackgroundColor(active.status_background_color),
        status_font: resolveStatusFont(active.status_font),
        sequence_steps: getTemplateSequenceSteps(active)
      });
    }
  }, [active, form]);

  const saveTemplate = useMutation({
    mutationFn: ({ templateId, payload }: { templateId: string | null; payload: TemplateFormValues }) => {
      return templateId
        ? api.put<Template>(`/api/templates/${templateId}`, payload)
        : api.post<Template>('/api/templates', payload);
    },
    onSuccess: (savedTemplate: Template) => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
      setActive(savedTemplate);
      form.reset({
        name: savedTemplate.name || '',
        content: savedTemplate.content || '',
        description: savedTemplate.description || '',
        active: savedTemplate.active ?? true,
        send_mode: resolveSendMode(savedTemplate),
        media_source: resolveTemplateMediaSource(savedTemplate.media_source),
        status_background_color: resolveStatusBackgroundColor(savedTemplate.status_background_color),
        status_font: resolveStatusFont(savedTemplate.status_font),
        sequence_steps: getTemplateSequenceSteps(savedTemplate)
      });
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
        form.reset({
          name: '',
          content: '',
          description: '',
          active: true,
          send_mode: 'auto_media',
          media_source: 'auto',
          status_background_color: DEFAULT_STATUS_BACKGROUND,
          status_font: 0,
          sequence_steps: []
        });
      }
    },
    onError: (error: unknown) => alert(`Failed to delete template: ${getErrorMessage(error)}`)
  });

  const sendPreview = useMutation({
    mutationFn: (payload: TemplatePreviewPayload) =>
      api.post<{ messageId?: string; confirmed?: number; uncertain?: number }>('/api/whatsapp/send-test', payload),
    onSuccess: (result: { messageId?: string; confirmed?: number; uncertain?: number }) => {
      const messageId = String(result?.messageId || '').trim();
      const confirmed = Number(result?.confirmed || 0);
      const uncertain = Number(result?.uncertain || 0);
      const suffix = messageId ? ` (${messageId})` : '';
      if (confirmed > 0 && uncertain > 0) {
        setPreviewSendNotice(`Recorded locally${suffix}. Confirmed ${confirmed}, awaiting confirmation ${uncertain}.`);
        return;
      }
      if (confirmed > 0) {
        setPreviewSendNotice(`Recorded locally${suffix}. Confirmed ${confirmed}.`);
        return;
      }
      if (uncertain > 0) {
        setPreviewSendNotice(`Recorded locally${suffix}. Awaiting confirmation ${uncertain}.`);
        return;
      }
      setPreviewSendNotice(messageId ? `Recorded locally (${messageId})` : 'Recorded locally');
    },
    onError: (error: unknown) => {
      setPreviewSendNotice(`Failed: ${getErrorMessage(error)}`);
    }
  });

  const onSubmit = (values: TemplateFormValues) => {
    const templateId = active?.id || null;
    saveTemplate.mutate({
      templateId,
      payload: {
        name: values.name,
        content: values.content,
        description: values.description,
        active: values.active === true,
        send_mode: values.send_mode,
        media_source: resolveTemplateMediaSource(values.media_source),
        status_background_color: resolveStatusBackgroundColor(values.status_background_color),
        status_font: resolveStatusFont(values.status_font),
        sequence_steps: values.sequence_steps
          .filter((step) => step.active !== false && String(step.content || '').trim())
          .map((step, index) => ({
            label: String(step.label || `Step ${index + 1}`).trim(),
            content: String(step.content || '').trim(),
            send_mode: step.send_mode,
            media_source: resolveTemplateMediaSource(step.media_source),
            status_background_color: resolveStatusBackgroundColor(step.status_background_color || values.status_background_color),
            status_font: resolveStatusFont(step.status_font ?? values.status_font),
            delay_seconds: Math.max(0, Math.min(3600, Number(step.delay_seconds || 0))),
            active: true
          }))
      }
    });
  };

  const submitPreviewSend = async () => {
    setPreviewSendNotice('');

    const jid = String(selectedPreviewTarget?.phone_number || '').trim();
    if (!jid) {
      setPreviewSendNotice('Pick a target first.');
      return;
    }

    const isStatusPreview = selectedPreviewTarget?.type === 'status';

    if (isStatusPreview && statusPreviewAudience.length === 0) {
      setPreviewSendNotice('Add a Status Preview Recipient in Settings before sending a Status preview.');
      return;
    }

    let payloads;
    try {
      payloads = buildTemplatePreviewSendPayloads({
        jid,
        isStatus: isStatusPreview,
        statusAudience: statusPreviewAudience,
        sampleData: previewWithData ? sampleData : {},
        fallback: {
          content: watchedContent || '',
          sendMode: resolveTemplateSendMode(watchedSendMode),
          mediaSource: resolveTemplateMediaSource(watchedMediaSource),
          statusBackgroundColor: resolveStatusBackgroundColor(watchedStatusBackgroundColor),
          statusFont: resolveStatusFont(watchedStatusFont)
        },
        sequenceSteps: watchedSequenceSteps.map((step, index) => ({
          label: String(step.label || `Step ${index + 1}`).trim(),
          content: String(step.content || ''),
          sendMode: resolveTemplateSendMode(step.send_mode),
          mediaSource: resolveTemplateMediaSource(step.media_source),
          statusBackgroundColor: resolveStatusBackgroundColor(step.status_background_color || watchedStatusBackgroundColor),
          statusFont: resolveStatusFont(step.status_font ?? watchedStatusFont),
          delaySeconds: Number(step.delay_seconds || 0),
          active: step.active !== false
        }))
      });
    } catch (error) {
      setPreviewSendNotice(getErrorMessage(error));
      return;
    }

    if (!payloads.length) {
      setPreviewSendNotice('Nothing to send.');
      return;
    }

    try {
      for (const [index, step] of payloads.entries()) {
        setPreviewSendNotice(
          payloads.length > 1
            ? `Sending ${step.label} (${index + 1}/${payloads.length})...`
            : 'Sending preview...'
        );
        await sendPreview.mutateAsync(step.payload);
      }
      if (payloads.length > 1) {
        setPreviewSendNotice(`Sequence preview recorded (${payloads.length} steps).`);
      }
    } catch {
      // useMutation already writes the operator-facing error into previewSendNotice.
    }
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

  const wrapSelection = (left: string, right?: string) => {
    const textarea = textareaRef.current;
    const currentContent = form.getValues('content') || '';
    const endToken = right ?? left;

    if (!textarea) {
      form.setValue('content', `${currentContent}${left}${endToken}`);
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = currentContent.slice(start, end);
    const next = `${currentContent.slice(0, start)}${left}${selected}${endToken}${currentContent.slice(end)}`;
    form.setValue('content', next);

    setTimeout(() => {
      textarea.focus();
      const cursorStart = start + left.length;
      const cursorEnd = cursorStart + selected.length;
      textarea.setSelectionRange(cursorStart, cursorEnd);
    }, 0);
  };

  const updateSequenceStep = (
    index: number,
    patch: Partial<TemplateFormValues['sequence_steps'][number]>
  ) => {
    const next = [...(form.getValues('sequence_steps') || [])];
    if (!next[index]) return;
    next[index] = { ...next[index], ...patch };
    form.setValue('sequence_steps', next, { shouldDirty: true, shouldValidate: true });
  };

  const addSequenceStep = () => {
    const current = form.getValues('sequence_steps') || [];
    const content = String(watchedContent || '').trim() || '{{description}}\n{{link}}';
    form.setValue(
      'sequence_steps',
      [
        ...current,
        {
          label: `Step ${current.length + 1}`,
          content,
          send_mode: current.length === 0 ? resolveTemplateSendMode(watchedSendMode) : 'auto_media',
          media_source: 'auto',
          status_background_color: resolveStatusBackgroundColor(watchedStatusBackgroundColor),
          status_font: resolveStatusFont(watchedStatusFont),
          delay_seconds: current.length === 0 ? 0 : 8,
          active: true
        }
      ],
      { shouldDirty: true, shouldValidate: true }
    );
  };

  const removeSequenceStep = (index: number) => {
    const current = form.getValues('sequence_steps') || [];
    form.setValue(
      'sequence_steps',
      current.filter((_, stepIndex) => stepIndex !== index),
      { shouldDirty: true, shouldValidate: true }
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
        <p className="text-muted-foreground">Write normal WhatsApp-style messages with variables and test exactly what will send.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                {active ? 'Edit Template' : 'Create Template'}
              </CardTitle>
              <CardDescription>Write normal WhatsApp copy. Insert feed fields with the chips below.</CardDescription>
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
                  <div className="flex flex-wrap gap-2 rounded-lg border p-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => wrapSelection('*')}>
                      Bold
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => wrapSelection('_')}>
                      Italic
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => wrapSelection('~')}>
                      Strike
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => wrapSelection('```', '```')}>
                      Code
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => insertVariable('link')}>
                      Insert link
                    </Button>
                  </div>
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
                        (() => {
                          const key = String(variable.name || '').trim();
                          const rawValue = (sampleData as Record<string, unknown>)[key];
                          const sampleValue = rawValue == null ? '' : String(rawValue);
                          const cleaned = sampleValue.replace(/\s+/g, ' ').trim();
                          const preview = cleaned.length > 42 ? `${cleaned.slice(0, 42)}...` : cleaned;
                          return (
                        <Button
                          key={variable.name}
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => insertVariable(variable.name)}
                          title={cleaned ? `${key}: ${cleaned}` : key}
                          className="h-auto max-w-full flex-col items-start gap-0.5 px-2 py-1 text-left"
                        >
                          <span className="text-xs font-medium leading-none">{key.replace(/_/g, ' ')}</span>
                          <span className="w-full truncate text-[10px] leading-none text-muted-foreground">
                            {preview || 'No sample value'}
                          </span>
                        </Button>
                          );
                        })()
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

                <div className="space-y-4 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label>Template enabled</Label>
                      <p className="text-xs text-muted-foreground">Disabled templates stay saved but are hidden from new automation choices.</p>
                    </div>
                    <Switch
                      checked={watchedActive === true}
                      onCheckedChange={(checked) => form.setValue('active', checked === true, { shouldDirty: true })}
                    />
                  </div>
                </div>

                <div className="space-y-4 rounded-lg border p-4">
                  <Label>Message format</Label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {([
                      { value: 'auto_media', label: 'Auto media' },
                      { value: 'media_only', label: 'Media only' },
                      { value: 'text_preview', label: 'Text + preview' },
                      { value: 'text_only', label: 'Text only' }
                    ] as const).map((option) => (
                      <Button
                        key={option.value}
                        type="button"
                        variant={watchedSendMode === option.value ? 'default' : 'outline'}
                        className="justify-start"
                        onClick={() => form.setValue('send_mode', option.value)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>

                  <p className="text-xs text-muted-foreground">{getTemplateModeDescription(watchedSendMode)}</p>

                  <input type="hidden" {...form.register('send_mode')} />

                  {(watchedSendMode === 'auto_media' || watchedSendMode === 'media_only') ? (
                    <div className="space-y-2 rounded-md border p-3">
                      <Label>Media source</Label>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {([
                          { value: 'auto', label: 'Auto' },
                          { value: 'image', label: 'Featured image' },
                          { value: 'video', label: 'Story video' }
                        ] as const).map((option) => (
                          <Button
                            key={option.value}
                            type="button"
                            variant={resolveTemplateMediaSource(watchedMediaSource) === option.value ? 'default' : 'outline'}
                            className="justify-start"
                            onClick={() =>
                              form.setValue('media_source', option.value, { shouldDirty: true, shouldValidate: true })
                            }
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                      <input type="hidden" {...form.register('media_source')} />
                    </div>
                  ) : (
                    <input type="hidden" {...form.register('media_source')} />
                  )}

                  <p className="border-t pt-3 text-xs text-muted-foreground">
                    Templates are always available to automations; pick which one to use on the Automations page.
                  </p>
                </div>

                <div className="space-y-4 rounded-lg border p-4">
                  <div>
                    <Label>Status text appearance</Label>
                    <p className="text-xs text-muted-foreground">
                      Used only when this template sends a text Status. Image and video statuses keep WhatsApp media styling.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-[1fr_170px]">
                    <div className="space-y-2">
                      <Label htmlFor="statusBackground">Background color</Label>
                      <div className="flex flex-wrap items-center gap-2">
                        {STATUS_BACKGROUND_SWATCHES.map((color) => (
                          <button
                            key={color}
                            type="button"
                            aria-label={`Use ${color}`}
                            className={`h-8 w-8 rounded-md border ${resolveStatusBackgroundColor(watchedStatusBackgroundColor) === color ? 'ring-2 ring-primary ring-offset-2' : ''}`}
                            style={{ backgroundColor: color }}
                            onClick={() => form.setValue('status_background_color', color, { shouldDirty: true, shouldValidate: true })}
                          />
                        ))}
                        <Input
                          id="statusBackground"
                          type="color"
                          className="h-9 w-14 p-1"
                          value={resolveStatusBackgroundColor(watchedStatusBackgroundColor)}
                          onChange={(event) =>
                            form.setValue('status_background_color', event.target.value, { shouldDirty: true, shouldValidate: true })
                          }
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Status font</Label>
                      <Select
                        value={String(resolveStatusFont(watchedStatusFont))}
                        onValueChange={(value) =>
                          form.setValue('status_font', Number(value), { shouldDirty: true, shouldValidate: true })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_FONT_OPTIONS.map((font) => (
                            <SelectItem key={font.value} value={String(font.value)}>
                              {font.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label>Status / Message Sequence</Label>
                      <p className="text-xs text-muted-foreground">
                        When steps are added, automations send each step in order for every story.
                      </p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={addSequenceStep}>
                      Add step
                    </Button>
                  </div>
                  {watchedSequenceSteps.length ? (
                    <div className="space-y-3">
                      {watchedSequenceSteps.map((step, index) => (
                        <div key={index} className="space-y-3 rounded-md border bg-muted/20 p-3">
                          <div className="grid gap-2 sm:grid-cols-[1fr_150px_150px_110px_auto]">
                            <Input
                              value={step.label || ''}
                              onChange={(event) => updateSequenceStep(index, { label: event.target.value })}
                              placeholder={`Step ${index + 1}`}
                            />
                            <Select
                              value={step.send_mode}
                              onValueChange={(value) =>
                                updateSequenceStep(index, { send_mode: value as TemplateFormValues['send_mode'] })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="text_only">Text only</SelectItem>
                                <SelectItem value="text_preview">Text + preview</SelectItem>
                                <SelectItem value="auto_media">Media + text</SelectItem>
                                <SelectItem value="media_only">Media only</SelectItem>
                              </SelectContent>
                            </Select>
                            <Select
                              value={resolveTemplateMediaSource(step.media_source)}
                              disabled={step.send_mode === 'text_only' || step.send_mode === 'text_preview'}
                              onValueChange={(value) =>
                                updateSequenceStep(index, { media_source: value as TemplateMediaSource })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="auto">Auto media</SelectItem>
                                <SelectItem value="image">Featured image</SelectItem>
                                <SelectItem value="video">Story video</SelectItem>
                              </SelectContent>
                            </Select>
                            <Input
                              type="number"
                              min={0}
                              max={3600}
                              value={Number(step.delay_seconds || 0)}
                              onChange={(event) => updateSequenceStep(index, { delay_seconds: Number(event.target.value || 0) })}
                              aria-label="Delay seconds"
                            />
                            <Button type="button" variant="ghost" size="icon" onClick={() => removeSequenceStep(index)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <Textarea
                            value={step.content || ''}
                            onChange={(event) => updateSequenceStep(index, { content: event.target.value })}
                            rows={3}
                            placeholder="Message for this step"
                          />
                          <div className="grid gap-3 sm:grid-cols-[1fr_170px]">
                            <div className="space-y-1.5">
                              <Label>Status color for this step</Label>
                              <div className="flex flex-wrap items-center gap-2">
                                {STATUS_BACKGROUND_SWATCHES.map((color) => (
                                  <button
                                    key={color}
                                    type="button"
                                    aria-label={`Use ${color}`}
                                    className={`h-7 w-7 rounded-md border ${resolveStatusBackgroundColor(step.status_background_color) === color ? 'ring-2 ring-primary ring-offset-2' : ''}`}
                                    style={{ backgroundColor: color }}
                                    onClick={() => updateSequenceStep(index, { status_background_color: color })}
                                  />
                                ))}
                                <Input
                                  type="color"
                                  className="h-8 w-12 p-1"
                                  value={resolveStatusBackgroundColor(step.status_background_color)}
                                  onChange={(event) => updateSequenceStep(index, { status_background_color: event.target.value })}
                                />
                              </div>
                            </div>
                            <div className="space-y-1.5">
                              <Label>Status font</Label>
                              <Select
                                value={String(resolveStatusFont(step.status_font))}
                                onValueChange={(value) => updateSequenceStep(index, { status_font: Number(value) })}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {STATUS_FONT_OPTIONS.map((font) => (
                                    <SelectItem key={font.value} value={String(font.value)}>
                                      {font.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No sequence steps. This template sends once using the message format above.
                    </p>
                  )}
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
                        form.reset({
                          name: '',
                          content: '',
                          description: '',
                          active: true,
                          send_mode: 'auto_media',
                          media_source: 'auto',
                          status_background_color: DEFAULT_STATUS_BACKGROUND,
                          status_font: 0,
                          sequence_steps: []
                        });
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
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5" />
                Send Preview
              </CardTitle>
              <CardDescription>Send this template to any active destination before enabling it in automations.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label>Target</Label>
                <Select
                  value={previewTargetKey || '__none'}
                  onValueChange={(value) => setPreviewTargetKey(value === '__none' ? '' : String(value || '').trim())}
                >
                  <SelectTrigger className="w-full min-w-0 max-w-full">
                    <SelectValue placeholder="Select target" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none" disabled>
                      Select target
                    </SelectItem>
                    {previewTargets.length > 0 ? (
                      previewTargets.map((target) => (
                        <SelectItem key={`${target.type}:${target.phone_number}`} value={`${target.type}:${target.phone_number}`} className="max-w-full">
                          {formatTargetLabel(target)}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="__empty" disabled>
                        No active targets
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-md border p-3 text-xs text-muted-foreground">
                {renderedSequencePreviewSteps.length ? (
                  <>
                    Sequence: <span className="font-medium text-foreground">{renderedSequencePreviewSteps.length} steps</span>
                    <br />
                    First step: <span className="font-medium text-foreground">{renderedSequencePreviewSteps[0]?.label}</span>
                  </>
                ) : (
                  <>
                    Format: <span className="font-medium text-foreground">{getTemplateModeLabel(watchedSendMode)}</span>
                    {(watchedSendMode === 'auto_media' || watchedSendMode === 'media_only') ? (
                      <>
                        <br />
                        Media: <span className="font-medium text-foreground">{getTemplateMediaSourceLabel(watchedMediaSource)}</span>
                      </>
                    ) : null}
                    {watchedSendMode === 'media_only' ? ' (requires sample media)' : ''}
                  </>
                )}
                {selectedPreviewTarget?.type === 'status' ? (
                  <>
                    <br />
                    Status preview audience: <span className="font-medium text-foreground">{statusPreviewAudience.length || 'not set'}</span>
                  </>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <Button type="button" onClick={submitPreviewSend} disabled={sendPreview.isPending || !selectedPreviewTarget}>
                  {sendPreview.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  {renderedSequencePreviewSteps.length ? 'Send Sequence Preview' : 'Send Preview'}
                </Button>
                {previewSendNotice ? <span className="text-sm text-muted-foreground">{previewSendNotice}</span> : null}
              </div>
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
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Sample item</Label>
                  <Select value={sampleItemKey} onValueChange={(value) => setSampleItemKey(value as typeof sampleItemKey)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Latest item" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="latest">Latest item</SelectItem>
                      <SelectItem value="with_image">With image</SelectItem>
                      <SelectItem value="with_video">With video</SelectItem>
                      <SelectItem value="no_media">No media</SelectItem>
                      <SelectItem value="long_title">Long title</SelectItem>
                      <SelectItem value="blank">Blank edge case</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground sm:self-end">
                  Pick different samples to preview edge cases before automations run.
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg bg-emerald-50/70 p-4 dark:bg-emerald-950/40">
                <div className="max-w-[85%] rounded-lg bg-white/80 px-3 py-2 shadow-sm ring-1 ring-emerald-200/60 dark:bg-emerald-900/50 dark:ring-emerald-800/60">
                  {previewWithData &&
                  (watchedSendMode === 'auto_media' || watchedSendMode === 'media_only') &&
                  selectedTemplateMedia.mediaKind === 'video' &&
                  isSafeVideoSrc(selectedTemplateMedia.mediaUrl) ? (
                    <div className="mb-2 overflow-hidden rounded-md border border-black/5 bg-black">
                      <video
                        src={selectedTemplateMedia.mediaUrl}
                        controls
                        className="block h-40 w-full object-cover"
                      />
                    </div>
                  ) : previewWithData &&
                  (watchedSendMode === 'auto_media' || watchedSendMode === 'media_only') &&
                  isSafeImageSrc(selectedTemplateMedia.mediaUrl) ? (
                    <div className="mb-2 overflow-hidden rounded-md border border-black/5 bg-white">
                      <Image
                        src={selectedTemplateMedia.mediaUrl}
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
                      __html: formatWhatsAppMarkdown(renderedPreviewText)
                    }}
                  />
                  <div className="text-right mt-1">
                    <span className="text-[10px] text-muted-foreground">12:00 PM</span>
                  </div>
                </div>
              </div>

              <div
                className="mt-4 flex min-h-[220px] items-center justify-center rounded-lg p-5 text-center text-white"
                style={{
                  backgroundColor: resolveStatusBackgroundColor(watchedStatusBackgroundColor),
                  fontFamily: getStatusPreviewFontFamily(watchedStatusFont)
                }}
              >
                <div className="max-w-[28rem] whitespace-pre-wrap text-2xl leading-snug">
                  {renderedPreviewText || 'Status text preview'}
                </div>
              </div>

              {renderedSequencePreviewSteps.length ? (
                <div className="mt-4 space-y-3 rounded-lg border p-3">
                  <div>
                    <p className="text-sm font-medium">Sequence preview</p>
                    <p className="text-xs text-muted-foreground">These steps are queued in this order for each story.</p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {renderedSequencePreviewSteps.map((step, position) => (
                      <div key={`${step.index}-${position}`} className="space-y-2 rounded-md border bg-muted/20 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {position + 1}. {step.label}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {getTemplateModeLabel(step.sendMode)}
                              {step.sendMode === 'auto_media' || step.sendMode === 'media_only'
                                ? ` / ${getTemplateMediaSourceLabel(step.mediaSource)}`
                                : ''}
                              {step.delaySeconds > 0 ? ` after ${step.delaySeconds}s` : ''}
                            </p>
                          </div>
                          <span
                            className="h-8 w-8 shrink-0 rounded-md border"
                            style={{ backgroundColor: step.backgroundColor }}
                            aria-label={`Status color ${step.backgroundColor}`}
                          />
                        </div>
                        <div
                          className="rounded-md p-3 text-sm text-white"
                          style={{
                            backgroundColor: step.backgroundColor,
                            fontFamily: getStatusPreviewFontFamily(step.font)
                          }}
                        >
                          <div className="max-h-32 overflow-hidden whitespace-pre-wrap">{step.renderedText}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {previewWithData ? (
                <p className="text-xs text-muted-foreground mt-2">
                  Sample:{' '}
                  {sampleItemKey === 'blank'
                    ? 'Blank edge case'
                    : sampleItem?.title
                      ? `"${String(sampleItem.title).slice(0, 60)}${String(sampleItem.title).length > 60 ? '...' : ''}"`
                      : 'Fallback example'}
                </p>
              ) : null}
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
                    <Badge variant="secondary" className="capitalize">
                      {getTemplateSequenceSteps(template).length
                        ? `${getTemplateSequenceSteps(template).length} steps`
                        : getTemplateModeLabel(template.send_mode)}
                    </Badge>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setActive(template);
                      }}
                    >
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
                  <div className="mt-2">
                    <Badge variant={template.active === false ? 'secondary' : 'success'}>
                      {template.active === false ? 'Disabled' : 'Enabled'}
                    </Badge>
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
