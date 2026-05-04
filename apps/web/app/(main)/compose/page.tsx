'use client';

import React, { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Target } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  FileText,
  Image as ImageIcon,
  Save,
  Send,
  Trash2,
  Upload,
  Video,
  Volume2,
  X,
  XCircle
} from 'lucide-react';

type AttachmentKind = 'image' | 'video' | 'audio' | 'document';

type ComposerAttachment = {
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  dataUrl?: string;
  url?: string;
};

type SavedAttachmentSummary = {
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
};

type ManualDraft = {
  id: string;
  name: string;
  updated_at: string;
  data: {
    message: string;
    disableLinkPreview: boolean;
    includeCaption: boolean;
    target_ids: string[];
    attachment?: SavedAttachmentSummary | null;
  };
};

type ManualBlock = {
  id: string;
  name: string;
  content: string;
  updated_at: string;
};

type SettingsShape = {
  manual_drafts?: ManualDraft[] | null;
  manual_blocks?: ManualBlock[] | null;
};

type ManualSendPayload = {
  target_ids: string[];
  message: string | null;
  disableLinkPreview: boolean;
  includeCaption: boolean;
  imageUrl?: string | null;
  videoUrl?: string | null;
  audioUrl?: string | null;
  documentUrl?: string | null;
  imageDataUrl?: string | null;
  videoDataUrl?: string | null;
  audioDataUrl?: string | null;
  documentDataUrl?: string | null;
  documentFilename?: string | null;
  documentMime?: string | null;
};

type NoticeType = 'success' | 'warning' | 'error';

type ManualSendResponse = {
  ok?: boolean;
  queued?: number;
  sent?: number;
  uncertain?: number;
  held?: number;
  pending?: number;
  processing?: number;
  skipped?: number;
  failed?: number;
};

const MAX_ATTACHMENT_BYTES: Record<AttachmentKind, number> = {
  image: 8 * 1024 * 1024,
  video: 32 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  document: 25 * 1024 * 1024
};

const ACCEPTED_ATTACHMENTS = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'audio/*',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
].join(',');

const makeId = () => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
};

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read attachment'));
    reader.readAsDataURL(file);
  });

const filenameFromUrl = (value: string, fallback: string) => {
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    return name || fallback;
  } catch {
    return fallback;
  }
};

const getAttachmentKind = (file: File): AttachmentKind | null => {
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (mime.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(name)) return 'image';
  if (mime.startsWith('video/') || /\.(mp4|mov|m4v)$/i.test(name)) return 'video';
  if (mime.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|wav)$/i.test(name)) return 'audio';
  if (mime || /\.(pdf|txt|csv|doc|docx)$/i.test(name)) return 'document';
  return null;
};

const validateAttachmentFile = (file: File, kind: AttachmentKind) => {
  if (file.size > MAX_ATTACHMENT_BYTES[kind]) {
    return `${kind[0]!.toUpperCase()}${kind.slice(1)} is too large. Limit: ${formatBytes(MAX_ATTACHMENT_BYTES[kind])}.`;
  }
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (kind === 'image' && !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    return 'Images must be jpeg, png, or webp.';
  }
  if (kind === 'video' && mime !== 'video/mp4' && !name.endsWith('.mp4')) {
    return 'Videos must be MP4 for WhatsApp.';
  }
  return null;
};

const targetTypeLabel = (type: Target['type']) => {
  switch (type) {
    case 'individual':
      return 'Person';
    case 'group':
      return 'Group';
    case 'channel':
      return 'Channel';
    case 'status':
      return 'Status';
    default:
      return 'Destination';
  }
};

const attachmentIcon = (kind: AttachmentKind) => {
  switch (kind) {
    case 'image':
      return <ImageIcon className="h-4 w-4" />;
    case 'video':
      return <Video className="h-4 w-4" />;
    case 'audio':
      return <Volume2 className="h-4 w-4" />;
    case 'document':
      return <FileText className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
};

const ComposeInner = () => {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [notice, setNotice] = useState<{ type: NoticeType; message: string } | null>(null);
  const [targetSearch, setTargetSearch] = useState('');
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const prefill = useMemo(() => {
    const title = String(searchParams?.get('title') || '').trim();
    const url = String(searchParams?.get('url') || '').trim();
    const mediaCandidates: Array<{ kind: AttachmentKind; value: string; fallback: string }> = [
      { kind: 'image', value: String(searchParams?.get('imageUrl') || '').trim(), fallback: 'Selected image' },
      { kind: 'video', value: String(searchParams?.get('videoUrl') || '').trim(), fallback: 'Selected video' },
      { kind: 'audio', value: String(searchParams?.get('audioUrl') || '').trim(), fallback: 'Selected audio' },
      { kind: 'document', value: String(searchParams?.get('documentUrl') || '').trim(), fallback: 'Selected document' }
    ];
    const selectedMedia = mediaCandidates.find((candidate) => candidate.value);
    const header = title ? `*${title}*` : '';
    return {
      message: [header, url].filter(Boolean).join('\n\n'),
      attachment: selectedMedia
        ? {
            kind: selectedMedia.kind,
            name: filenameFromUrl(selectedMedia.value, selectedMedia.fallback),
            mime: '',
            size: 0,
            url: selectedMedia.value
          }
        : null
    };
  }, [searchParams]);

  const [message, setMessage] = useState(() => prefill.message);
  const [attachment, setAttachment] = useState<ComposerAttachment | null>(() => prefill.attachment);
  const [disableLinkPreview, setDisableLinkPreview] = useState(false);
  const [includeCaption, setIncludeCaption] = useState(true);
  const [blockName, setBlockName] = useState('');
  const [blockContent, setBlockContent] = useState('');

  const { data: targets = [], isLoading: targetsLoading } = useQuery<Target[]>({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const { data: settings } = useQuery<SettingsShape>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
    staleTime: 30000
  });

  const drafts = useMemo<ManualDraft[]>(() => {
    const value = settings?.manual_drafts;
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is ManualDraft => Boolean(entry && typeof entry === 'object' && typeof entry.id === 'string'))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }, [settings?.manual_drafts]);

  const blocks = useMemo<ManualBlock[]>(() => {
    const value = settings?.manual_blocks;
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is ManualBlock => Boolean(entry && typeof entry === 'object' && typeof entry.id === 'string'))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }, [settings?.manual_blocks]);

  const selectableTargets = useMemo(() => targets.filter((target) => target.active !== false), [targets]);
  const filteredTargets = useMemo(() => {
    const term = targetSearch.trim().toLowerCase();
    if (!term) return selectableTargets;
    return selectableTargets.filter((target) => {
      const name = String(target.name || '').toLowerCase();
      const type = String(target.type || '').toLowerCase();
      const address = String(target.phone_number || '').toLowerCase();
      return name.includes(term) || type.includes(term) || address.includes(term);
    });
  }, [selectableTargets, targetSearch]);

  const selectedTargets = useMemo(
    () => selectableTargets.filter((target) => selectedTargetIds.includes(target.id)),
    [selectableTargets, selectedTargetIds]
  );

  const updateDrafts = useMutation({
    mutationFn: (next: ManualDraft[]) => api.put('/api/settings', { manual_drafts: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    }
  });

  const updateBlocks = useMutation({
    mutationFn: (next: ManualBlock[]) => api.put('/api/settings', { manual_blocks: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    }
  });

  const buildManualPayload = (): ManualSendPayload => {
    const payload: ManualSendPayload = {
      target_ids: selectedTargetIds,
      message: message.trim() || null,
      disableLinkPreview,
      includeCaption
    };

    if (!attachment) return payload;
    if (attachment.kind === 'image') {
      if (attachment.dataUrl) payload.imageDataUrl = attachment.dataUrl;
      else if (attachment.url) payload.imageUrl = attachment.url;
    }
    if (attachment.kind === 'video') {
      if (attachment.dataUrl) payload.videoDataUrl = attachment.dataUrl;
      else if (attachment.url) payload.videoUrl = attachment.url;
    }
    if (attachment.kind === 'audio') {
      if (attachment.dataUrl) payload.audioDataUrl = attachment.dataUrl;
      else if (attachment.url) payload.audioUrl = attachment.url;
    }
    if (attachment.kind === 'document') {
      if (attachment.dataUrl) payload.documentDataUrl = attachment.dataUrl;
      else if (attachment.url) payload.documentUrl = attachment.url;
      payload.documentFilename = attachment.name;
      payload.documentMime = attachment.mime || null;
    }
    return payload;
  };

  const queueManual = useMutation({
    mutationFn: () => api.post<{ queued?: number }>('/api/manual/queue', buildManualPayload()),
    onSuccess: (result: { queued?: number }) => {
      setNotice({ type: 'success', message: `Queued ${Number(result?.queued || 0)} message(s).` });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['queue-stats'] });
      router.push('/queue?include_manual=true');
    },
    onError: (error: unknown) => {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Queue failed' });
    }
  });

  const sendManualNow = useMutation({
    mutationFn: () => api.post<ManualSendResponse>('/api/manual/send', buildManualPayload()),
    onSuccess: (result: ManualSendResponse) => {
      const sent = Number(result?.sent || 0);
      const uncertain = Number(result?.uncertain || 0);
      const held = Number(result?.held || 0);
      const pending = Number(result?.pending || 0);
      const processing = Number(result?.processing || 0);
      const skipped = Number(result?.skipped || 0);
      const failed = Number(result?.failed || 0);
      const parts = [
        sent ? `sent ${sent}` : '',
        uncertain ? `needs verification ${uncertain}` : '',
        held ? `held for review ${held}` : '',
        pending ? `still queued ${pending}` : '',
        processing ? `still processing ${processing}` : '',
        skipped ? `skipped ${skipped}` : '',
        failed ? `failed ${failed}` : ''
      ].filter(Boolean);
      if (failed > 0 || skipped > 0) {
        setNotice({ type: 'error', message: `${parts.join(', ')}. Open Queue for the exact records.` });
      } else if (uncertain > 0 || held > 0 || pending > 0 || processing > 0 || result?.ok === false) {
        setNotice({ type: 'warning', message: `${parts.join(', ') || 'Delivery is still being verified'}. Open Queue for the exact records.` });
      } else {
        setNotice({ type: 'success', message: `Sent ${sent} message(s).` });
      }
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['queue-stats'] });
      queryClient.invalidateQueries({ queryKey: ['logs'] });
    },
    onError: (error: unknown) => {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Send failed' });
    }
  });

  const handleAttachmentChange = async (file: File | null) => {
    if (!file) return;
    const kind = getAttachmentKind(file);
    if (!kind) {
      setNotice({ type: 'error', message: 'Choose an image, MP4 video, audio file, or document.' });
      return;
    }

    const validationError = validateAttachmentFile(file, kind);
    if (validationError) {
      setNotice({ type: 'error', message: validationError });
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      setAttachment({
        kind,
        name: file.name || `${kind}-attachment`,
        mime: file.type || (kind === 'video' ? 'video/mp4' : 'application/octet-stream'),
        size: file.size,
        dataUrl
      });
      setNotice(null);
    } catch (error: unknown) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Could not read attachment' });
    }
  };

  const validateBeforeDispatch = () => {
    if (!selectedTargetIds.length) {
      setNotice({ type: 'error', message: 'Select at least one destination.' });
      return false;
    }
    if (!message.trim() && !attachment) {
      setNotice({ type: 'error', message: 'Add message text or choose an attachment.' });
      return false;
    }
    if (attachment && attachment.kind !== 'image' && attachment.kind !== 'video') {
      const hasStatusTarget = selectedTargets.some((target) => target.type === 'status');
      if (hasStatusTarget) {
        setNotice({ type: 'error', message: 'Status supports text, images, and videos only.' });
        return false;
      }
    }
    return true;
  };

  const buildDraftPayload = (nameOverride?: string) => {
    const nowIso = new Date().toISOString();
    const id = activeDraftId || makeId();
    const derivedName =
      String(nameOverride || draftName || '').trim() ||
      (message.trim() ? message.trim().split('\n')[0]!.slice(0, 40) : '') ||
      `Draft ${new Date().toLocaleString()}`;

    const draft: ManualDraft = {
      id,
      name: derivedName,
      updated_at: nowIso,
      data: {
        message,
        disableLinkPreview,
        includeCaption,
        target_ids: selectedTargetIds,
        attachment: attachment
          ? {
            kind: attachment.kind,
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size
          }
          : null
      }
    };
    return draft;
  };

  const saveDraft = async () => {
    const draft = buildDraftPayload();
    const next = (() => {
      const existing = drafts.slice();
      const index = existing.findIndex((entry) => entry.id === draft.id);
      if (index >= 0) {
        existing[index] = draft;
        return existing;
      }
      return [draft, ...existing].slice(0, 60);
    })();
    setActiveDraftId(draft.id);
    setDraftName(draft.name);
    try {
      await updateDrafts.mutateAsync(next);
      setNotice({
        type: 'success',
        message: attachment ? 'Draft saved. Re-select the attachment before sending this draft later.' : 'Draft saved.'
      });
    } catch (error: unknown) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Draft save failed' });
    }
  };

  const loadDraft = (draft: ManualDraft) => {
    setActiveDraftId(draft.id);
    setDraftName(draft.name);
    setMessage(String(draft.data?.message || ''));
    setDisableLinkPreview(Boolean(draft.data?.disableLinkPreview));
    setIncludeCaption(draft.data?.includeCaption !== false);
    setSelectedTargetIds(Array.isArray(draft.data?.target_ids) ? draft.data.target_ids : []);
    setAttachment(null);
    setNotice(
      draft.data?.attachment
        ? { type: 'error', message: `Draft loaded. Choose "${draft.data.attachment.name}" again before sending.` }
        : null
    );
  };

  const clearComposer = () => {
    setActiveDraftId(null);
    setDraftName('');
    setMessage('');
    setAttachment(null);
    setDisableLinkPreview(false);
    setIncludeCaption(true);
    setSelectedTargetIds([]);
    setNotice(null);
  };

  const deleteDraft = async (id: string) => {
    try {
      await updateDrafts.mutateAsync(drafts.filter((draft) => draft.id !== id));
      if (activeDraftId === id) clearComposer();
      setNotice({ type: 'success', message: 'Draft deleted.' });
    } catch (error: unknown) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Draft delete failed' });
    }
  };

  const saveBlock = async () => {
    const name = blockName.trim();
    const content = blockContent.trim();
    if (!name || !content) {
      setNotice({ type: 'error', message: 'Block name and content are required.' });
      return;
    }

    const block: ManualBlock = { id: makeId(), name, content, updated_at: new Date().toISOString() };
    try {
      await updateBlocks.mutateAsync([block, ...blocks].slice(0, 80));
      setBlockName('');
      setBlockContent('');
      setNotice({ type: 'success', message: 'Block saved.' });
    } catch (error: unknown) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Block save failed' });
    }
  };

  const deleteBlock = async (id: string) => {
    try {
      await updateBlocks.mutateAsync(blocks.filter((block) => block.id !== id));
      setNotice({ type: 'success', message: 'Block deleted.' });
    } catch (error: unknown) {
      setNotice({ type: 'error', message: error instanceof Error ? error.message : 'Block delete failed' });
    }
  };

  const insertBlock = (content: string) => {
    const normalized = String(content || '');
    if (!normalized) return;
    setMessage((current) => (current ? `${current}\n\n${normalized}` : normalized));
  };

  const toggleTarget = (id: string, checked: boolean) => {
    setSelectedTargetIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return Array.from(next);
    });
  };

  const toggleAllFilteredTargets = (checked: boolean) => {
    const ids = filteredTargets.map((target) => target.id).filter(Boolean);
    setSelectedTargetIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return Array.from(next);
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Compose</h1>
          <p className="text-muted-foreground">Send or queue a normal WhatsApp message with optional attachment.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={saveDraft} disabled={updateDrafts.isPending}>
            <Save className="mr-2 h-4 w-4" />
            Save draft
          </Button>
          <Button type="button" variant="ghost" onClick={clearComposer}>
            <Trash2 className="mr-2 h-4 w-4" />
            Clear
          </Button>
        </div>
      </div>

      {notice ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${notice.type === 'success'
            ? 'border-emerald-300/70 bg-emerald-50 text-emerald-900'
            : notice.type === 'warning'
              ? 'border-amber-300/70 bg-amber-50 text-amber-900'
              : 'border-red-300/70 bg-red-50 text-red-900'
            }`}
        >
          <div className="flex items-start gap-2">
            {notice.type === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4" />
            ) : notice.type === 'warning' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4" />
            )}
            <span>{notice.message}</span>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Message</CardTitle>
              <CardDescription>Text-only, image with caption, video with caption, audio, and document sends use the same queue records.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="draftName">Draft name</Label>
                <Input
                  id="draftName"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  placeholder="Morning update"
                />
                {activeDraftId ? (
                  <p className="text-xs text-muted-foreground">
                    Editing draft <Badge variant="secondary" className="ml-1">{activeDraftId.slice(0, 8)}</Badge>
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="message">Text or caption</Label>
                <Textarea
                  id="message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Type the message exactly as it should appear..."
                  className="min-h-[170px]"
                />
                <p className="text-xs text-muted-foreground">{message.length}/4096 characters</p>
              </div>

              <div className="space-y-3 rounded-md border bg-background p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">Attachment</p>
                    <p className="text-xs text-muted-foreground">Choose a file from this computer. No URL paste is needed.</p>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      id="attachmentFile"
                      type="file"
                      accept={ACCEPTED_ATTACHMENTS}
                      className="hidden"
                      onChange={(event) => {
                        void handleAttachmentChange(event.currentTarget.files?.[0] || null);
                        event.currentTarget.value = '';
                      }}
                    />
                    <Button type="button" variant="outline" asChild>
                      <Label htmlFor="attachmentFile" className="cursor-pointer">
                        <Upload className="mr-2 h-4 w-4" />
                        Choose file
                      </Label>
                    </Button>
                    {attachment ? (
                      <Button type="button" variant="ghost" onClick={() => setAttachment(null)}>
                        <X className="mr-2 h-4 w-4" />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>

                {attachment ? (
                  <div className="grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-[96px_1fr]">
                    <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-background">
                      {attachment.kind === 'image' ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={attachment.dataUrl || attachment.url} alt="" className="h-full w-full object-cover" />
                      ) : attachment.kind === 'video' ? (
                        <video src={attachment.dataUrl || attachment.url} className="h-full w-full object-cover" muted />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          {attachmentIcon(attachment.kind)}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="gap-1">
                          {attachmentIcon(attachment.kind)}
                          {attachment.kind}
                        </Badge>
                        <span className="truncate text-sm font-medium">{attachment.name}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {attachment.mime || (attachment.url ? 'Selected from feed item' : 'application/octet-stream')} - {attachment.size ? formatBytes(attachment.size) : 'remote media'}
                      </p>
                      <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">Use text as caption</p>
                          <p className="text-xs text-muted-foreground">
                            Off means the attachment is sent without the text attached to it.
                          </p>
                        </div>
                        <Switch checked={includeCaption} onCheckedChange={setIncludeCaption} />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                    No attachment selected. This will send as a text-only message when text is present.
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Link preview</p>
                  <p className="text-xs text-muted-foreground">Turn off if the text contains a link but should not show a preview card.</p>
                </div>
                <Switch checked={!disableLinkPreview} onCheckedChange={(checked) => setDisableLinkPreview(!checked)} />
              </div>

              <Separator />

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    if (!validateBeforeDispatch()) return;
                    queueManual.mutate();
                  }}
                  disabled={queueManual.isPending}
                >
                  <ClipboardPaste className="mr-2 h-4 w-4" />
                  Queue
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (!validateBeforeDispatch()) return;
                    sendManualNow.mutate();
                  }}
                  disabled={sendManualNow.isPending}
                >
                  <Send className="mr-2 h-4 w-4" />
                  Send now
                </Button>
                <Button type="button" variant="outline" asChild>
                  <Link href="/queue?include_manual=true">Open Queue</Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Destinations</CardTitle>
              <CardDescription>
                Selected: <span className="font-medium">{selectedTargetIds.length}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Input
                  value={targetSearch}
                  onChange={(event) => setTargetSearch(event.target.value)}
                  placeholder="Search people, groups, channels, or status..."
                  className="sm:max-w-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => toggleAllFilteredTargets(true)}
                  disabled={targetsLoading || filteredTargets.length === 0}
                >
                  Select all shown
                </Button>
              </div>

              {targetsLoading ? (
                <p className="text-sm text-muted-foreground">Loading destinations...</p>
              ) : filteredTargets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active destinations found.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {filteredTargets.map((target) => {
                    const checked = selectedTargetIds.includes(target.id);
                    return (
                      <label
                        key={target.id}
                        className="flex min-h-16 cursor-pointer items-start gap-3 rounded-md border bg-background px-3 py-2 hover:bg-muted/20"
                      >
                        <Checkbox checked={checked} onCheckedChange={(value) => toggleTarget(target.id, value === true)} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{target.name}</span>
                          <span className="mt-1 inline-flex">
                            <Badge variant="outline">{targetTypeLabel(target.type)}</Badge>
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>What will be queued for each selected destination.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-md border bg-muted/20 p-3">
                {attachment ? (
                  <div className="mb-3 overflow-hidden rounded-md bg-background">
                    {attachment.kind === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={attachment.dataUrl || attachment.url} alt="" className="max-h-64 w-full object-contain" />
                    ) : attachment.kind === 'video' ? (
                      <video src={attachment.dataUrl || attachment.url} controls className="max-h-64 w-full bg-black" />
                    ) : attachment.kind === 'audio' ? (
                      <audio src={attachment.dataUrl || attachment.url} controls className="w-full" />
                    ) : (
                      <div className="flex items-center gap-2 p-3 text-sm">
                        <FileText className="h-4 w-4" />
                        <span className="truncate">{attachment.name}</span>
                      </div>
                    )}
                  </div>
                ) : null}
                {message.trim() ? (
                  <p className="whitespace-pre-wrap text-sm leading-6">{message}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">{attachment ? 'No caption text.' : 'No text yet.'}</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {attachment ? <Badge variant="secondary">{attachment.kind} attached</Badge> : <Badge variant="outline">Text-only</Badge>}
                {attachment && includeCaption ? <Badge variant="secondary">Text used as caption</Badge> : null}
                {disableLinkPreview ? <Badge variant="outline">No link preview</Badge> : <Badge variant="outline">Link preview allowed</Badge>}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Drafts</CardTitle>
              <CardDescription>{drafts.length} saved draft{drafts.length !== 1 ? 's' : ''}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {drafts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No drafts yet.</p>
              ) : (
                drafts.map((draft) => (
                  <div key={draft.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{draft.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Updated {draft.updated_at ? new Date(draft.updated_at).toLocaleString() : '-'}
                        </p>
                        {draft.data?.attachment ? (
                          <Badge variant="outline" className="mt-2">
                            {draft.data.attachment.kind}: {draft.data.attachment.name}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button size="sm" variant="outline" onClick={() => loadDraft(draft)}>
                          Load
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => deleteDraft(draft.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    {draft.data?.message ? (
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{draft.data.message}</p>
                    ) : null}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Reusable Blocks</CardTitle>
              <CardDescription>Save snippets and insert them into the text box.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="blockName">Block name</Label>
                  <Input id="blockName" value={blockName} onChange={(event) => setBlockName(event.target.value)} placeholder="Subscribe line" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="blockContent">Block text</Label>
                  <Textarea
                    id="blockContent"
                    value={blockContent}
                    onChange={(event) => setBlockContent(event.target.value)}
                    placeholder="Text to insert..."
                    className="min-h-[96px]"
                  />
                </div>
                <Button type="button" size="sm" onClick={saveBlock} disabled={updateBlocks.isPending}>
                  <Save className="mr-2 h-4 w-4" />
                  Save block
                </Button>
              </div>

              {blocks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No blocks yet.</p>
              ) : (
                <div className="space-y-2">
                  {blocks.map((block) => (
                    <div key={block.id} className="rounded-md border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{block.name}</p>
                          <p className="text-xs text-muted-foreground">
                            Updated {block.updated_at ? new Date(block.updated_at).toLocaleString() : '-'}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <Button size="sm" variant="outline" onClick={() => insertBlock(block.content)}>
                            Insert
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => deleteBlock(block.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{block.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

const ComposePage = () => {
  return (
    <Suspense
      fallback={
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Compose</h1>
          <p className="text-muted-foreground">Loading composer...</p>
        </div>
      }
    >
      <ComposeInner />
    </Suspense>
  );
};

export default ComposePage;
