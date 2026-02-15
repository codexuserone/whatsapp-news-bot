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
import { Send, Save, Trash2, ClipboardPaste, CheckCircle2, XCircle } from 'lucide-react';

type ManualDraft = {
  id: string;
  name: string;
  updated_at: string;
  data: {
    message: string;
    imageUrl: string;
    videoUrl: string;
    disableLinkPreview: boolean;
    includeCaption: boolean;
    target_ids: string[];
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

const normalizeUrlInput = (value: unknown) => String(value ?? '').trim();
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

const ComposeInner = () => {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [targetSearch, setTargetSearch] = useState('');
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const prefill = useMemo(() => {
    const title = String(searchParams.get('title') || '').trim();
    const url = String(searchParams.get('url') || '').trim();
    const prefillImageUrl = String(searchParams.get('imageUrl') || '').trim();
    const header = title ? `*${title}*` : '';
    const nextMessage = [header, url].filter(Boolean).join('\n\n');
    return {
      message: nextMessage,
      imageUrl: prefillImageUrl
    };
  }, [searchParams]);

  const [message, setMessage] = useState(() => prefill.message);
  const [imageUrl, setImageUrl] = useState(() => prefill.imageUrl);
  const [videoUrl, setVideoUrl] = useState('');
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

  const filteredTargets = useMemo(() => {
    const term = targetSearch.trim().toLowerCase();
    if (!term) return targets;
    return targets.filter((t) => {
      const name = String(t.name || '').toLowerCase();
      const addr = String(t.phone_number || '').toLowerCase();
      return name.includes(term) || addr.includes(term);
    });
  }, [targets, targetSearch]);

  const selectedCount = selectedTargetIds.length;

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

  const queueManual = useMutation({
    mutationFn: () =>
      api.post<{ queued?: number }>('/api/manual/queue', {
        target_ids: selectedTargetIds,
        message: message.trim() || null,
        imageUrl: normalizeUrlInput(imageUrl) || null,
        videoUrl: normalizeUrlInput(videoUrl) || null,
        disableLinkPreview,
        includeCaption
      }),
    onSuccess: (result: { queued?: number }) => {
      setNotice({ type: 'success', message: `Queued ${Number(result?.queued || 0)} manual message(s).` });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['queue-stats'] });
      router.push('/queue?include_manual=true');
    },
    onError: (error: unknown) => {
      const msg = error instanceof Error ? error.message : 'Queue failed';
      setNotice({ type: 'error', message: msg });
    }
  });

  const sendManualNow = useMutation({
    mutationFn: () =>
      api.post<{ sent?: number; failed?: number; ok?: boolean }>('/api/manual/send', {
        target_ids: selectedTargetIds,
        message: message.trim() || null,
        imageUrl: normalizeUrlInput(imageUrl) || null,
        videoUrl: normalizeUrlInput(videoUrl) || null,
        disableLinkPreview,
        includeCaption
      }),
    onSuccess: (result: { sent?: number; failed?: number; ok?: boolean }) => {
      const sent = Number(result?.sent || 0);
      const failed = Number(result?.failed || 0);
      if (failed > 0 || result?.ok === false) {
        setNotice({ type: 'error', message: `Sent ${sent}, failed ${failed}. Check Queue/History for details.` });
      } else {
        setNotice({ type: 'success', message: `Sent ${sent} message(s).` });
      }
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['queue-stats'] });
      queryClient.invalidateQueries({ queryKey: ['logs'] });
    },
    onError: (error: unknown) => {
      const msg = error instanceof Error ? error.message : 'Send failed';
      setNotice({ type: 'error', message: msg });
    }
  });

  const validateBeforeDispatch = () => {
    if (!selectedTargetIds.length) {
      setNotice({ type: 'error', message: 'Select at least one target.' });
      return false;
    }

    const hasText = Boolean(message.trim());
    const hasImage = Boolean(normalizeUrlInput(imageUrl));
    const hasVideo = Boolean(normalizeUrlInput(videoUrl));
    if (!hasText && !hasImage && !hasVideo) {
      setNotice({ type: 'error', message: 'Add a message or a media URL.' });
      return false;
    }
    if (hasImage && hasVideo) {
      setNotice({ type: 'error', message: 'Use either image URL or video URL, not both.' });
      return false;
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
        imageUrl,
        videoUrl,
        disableLinkPreview,
        includeCaption,
        target_ids: selectedTargetIds
      }
    };
    return draft;
  };

  const saveDraft = async () => {
    const draft = buildDraftPayload();
    const next = (() => {
      const existing = drafts.slice();
      const idx = existing.findIndex((d) => d.id === draft.id);
      if (idx >= 0) {
        existing[idx] = draft;
        return existing;
      }
      return [draft, ...existing].slice(0, 60);
    })();
    setActiveDraftId(draft.id);
    setDraftName(draft.name);
    try {
      await updateDrafts.mutateAsync(next);
      setNotice({ type: 'success', message: 'Draft saved.' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Draft save failed';
      setNotice({ type: 'error', message: msg });
    }
  };

  const loadDraft = (draft: ManualDraft) => {
    setActiveDraftId(draft.id);
    setDraftName(draft.name);
    setMessage(String(draft.data?.message || ''));
    setImageUrl(String(draft.data?.imageUrl || ''));
    setVideoUrl(String(draft.data?.videoUrl || ''));
    setDisableLinkPreview(Boolean(draft.data?.disableLinkPreview));
    setIncludeCaption(draft.data?.includeCaption !== false);
    setSelectedTargetIds(Array.isArray(draft.data?.target_ids) ? draft.data.target_ids : []);
    setNotice(null);
  };

  const clearComposer = () => {
    setActiveDraftId(null);
    setDraftName('');
    setMessage('');
    setImageUrl('');
    setVideoUrl('');
    setDisableLinkPreview(false);
    setIncludeCaption(true);
    setSelectedTargetIds([]);
    setNotice(null);
  };

  const deleteDraft = async (id: string) => {
    const next = drafts.filter((d) => d.id !== id);
    try {
      await updateDrafts.mutateAsync(next);
      if (activeDraftId === id) {
        clearComposer();
      }
      setNotice({ type: 'success', message: 'Draft deleted.' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Draft delete failed';
      setNotice({ type: 'error', message: msg });
    }
  };

  const saveBlock = async () => {
    const name = blockName.trim();
    const content = blockContent.trim();
    if (!name || !content) {
      setNotice({ type: 'error', message: 'Block name and content are required.' });
      return;
    }
    const nowIso = new Date().toISOString();
    const block: ManualBlock = { id: makeId(), name, content, updated_at: nowIso };
    const next = [block, ...blocks].slice(0, 80);
    try {
      await updateBlocks.mutateAsync(next);
      setBlockName('');
      setBlockContent('');
      setNotice({ type: 'success', message: 'Block saved.' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Block save failed';
      setNotice({ type: 'error', message: msg });
    }
  };

  const deleteBlock = async (id: string) => {
    const next = blocks.filter((b) => b.id !== id);
    try {
      await updateBlocks.mutateAsync(next);
      setNotice({ type: 'success', message: 'Block deleted.' });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Block delete failed';
      setNotice({ type: 'error', message: msg });
    }
  };

  const insertBlock = (content: string) => {
    const normalized = String(content || '');
    if (!normalized) return;
    setMessage((current) => (current ? `${current}\n\n${normalized}` : normalized));
  };

  const toggleTarget = (id: string, checked: boolean) => {
    setSelectedTargetIds((current) => {
      const set = new Set(current);
      if (checked) set.add(id);
      else set.delete(id);
      return Array.from(set);
    });
  };

  const toggleAllFilteredTargets = (checked: boolean) => {
    const ids = filteredTargets.map((t) => t.id).filter(Boolean);
    setSelectedTargetIds((current) => {
      const set = new Set(current);
      for (const id of ids) {
        if (checked) set.add(id);
        else set.delete(id);
      }
      return Array.from(set);
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Compose</h1>
          <p className="text-muted-foreground">Write a manual post and send it now or queue it for later.</p>
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
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.type === 'success'
              ? 'border-emerald-300/70 bg-emerald-50 text-emerald-900'
              : 'border-red-300/70 bg-red-50 text-red-900'
          }`}
        >
          <div className="flex items-start gap-2">
            {notice.type === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <XCircle className="mt-0.5 h-4 w-4" />}
            <span>{notice.message}</span>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Message</CardTitle>
              <CardDescription>WhatsApp formatting is supported. Paste links, add media URL, and pick targets.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="draftName">Draft name (optional)</Label>
                <Input
                  id="draftName"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="e.g. Morning update"
                />
                {activeDraftId ? (
                  <p className="text-xs text-muted-foreground">
                    Editing draft <Badge variant="secondary" className="ml-1">{activeDraftId.slice(0, 8)}</Badge>
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="message">Message text</Label>
                <Textarea
                  id="message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type your update..."
                  className="min-h-[170px]"
                />
                <p className="text-xs text-muted-foreground">
                  {message.length}/4096 characters
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="imageUrl">Image URL (optional)</Label>
                  <Input
                    id="imageUrl"
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://..."
                    inputMode="url"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="videoUrl">Video URL (MP4, optional)</Label>
                  <Input
                    id="videoUrl"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="https://..."
                    inputMode="url"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Disable link preview</p>
                    <p className="text-xs text-muted-foreground">Sends text with no preview card.</p>
                  </div>
                  <Switch checked={disableLinkPreview} onCheckedChange={setDisableLinkPreview} />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Include caption</p>
                    <p className="text-xs text-muted-foreground">Use message text as media caption.</p>
                  </div>
                  <Switch checked={includeCaption} onCheckedChange={setIncludeCaption} />
                </div>
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
              <CardTitle>Targets</CardTitle>
              <CardDescription>
                Selected: <span className="font-medium">{selectedCount}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Input
                  value={targetSearch}
                  onChange={(e) => setTargetSearch(e.target.value)}
                  placeholder="Search targets..."
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
                <p className="text-sm text-muted-foreground">Loading targets...</p>
              ) : filteredTargets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No targets found.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {filteredTargets.map((target) => {
                    const checked = selectedTargetIds.includes(target.id);
                    return (
                      <label
                        key={target.id}
                        className="flex cursor-pointer items-start gap-3 rounded-md border bg-background px-3 py-2 hover:bg-muted/20"
                      >
                        <Checkbox checked={checked} onCheckedChange={(val) => toggleTarget(target.id, val === true)} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{target.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {target.type} - {target.phone_number}
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
              <CardTitle>Drafts</CardTitle>
              <CardDescription>{drafts.length} saved draft{drafts.length !== 1 ? 's' : ''}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {drafts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No drafts yet. Use the Save draft button to store one.</p>
              ) : (
                drafts.map((draft) => (
                  <div key={draft.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{draft.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Updated {draft.updated_at ? new Date(draft.updated_at).toLocaleString() : '-'}
                        </p>
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
                      <p
                        className="mt-2 text-xs text-muted-foreground"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden'
                        }}
                      >
                        {draft.data.message}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Reusable Blocks</CardTitle>
              <CardDescription>Save snippets and insert them into your message.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="blockName">Block name</Label>
                  <Input id="blockName" value={blockName} onChange={(e) => setBlockName(e.target.value)} placeholder="e.g. Subscribe line" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="blockContent">Block text</Label>
                  <Textarea
                    id="blockContent"
                    value={blockContent}
                    onChange={(e) => setBlockContent(e.target.value)}
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
                      <p
                        className="mt-2 text-xs text-muted-foreground"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden'
                        }}
                      >
                        {block.content}
                      </p>
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
