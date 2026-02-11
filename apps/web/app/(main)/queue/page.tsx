'use client';

import React, { useMemo, useState } from 'react';
import Image from 'next/image';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { QueueItem, ShabbosStatus, WhatsAppOutbox, WhatsAppOutboxStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  ListOrdered,
  RefreshCw,
  Trash2,
  AlertTriangle,
  Loader2,
  PauseCircle,
  PlayCircle,
  Pencil,
  Save,
  X,
  Send,
  LayoutGrid
} from 'lucide-react';

type QueueStats = {
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  skipped: number;
  total: number;
};

const mapMessageStatusLabel = (status?: number | null, statusLabel?: string | null) => {
  if (statusLabel) return statusLabel;
  switch (status) {
    case 0:
      return 'error';
    case 1:
      return 'pending';
    case 2:
      return 'server';
    case 3:
      return 'delivered';
    case 4:
      return 'read';
    case 5:
      return 'played';
    default:
      return null;
  }
};

const WHATSAPP_SENT_EDIT_WINDOW_MINUTES = 15;

const isSafeImageSrc = (value: unknown) => {
  const src = String(value || '').trim();
  if (!src) return false;
  if (src.startsWith('data:image/')) return true;
  if (src.startsWith('/')) return true;
  return src.startsWith('http://') || src.startsWith('https://');
};

const deriveDefaultMessage = (item: QueueItem) => {
  const title = String(item.title || '').trim();
  const url = String(item.url || '').trim();
  const chunks = [title, url].filter(Boolean);
  return chunks.join('\n\n');
};

const canEditSentInPlace = (item: QueueItem) => {
  if (item.status !== 'sent') return false;
  if (item.target_type === 'status' || item.target_type === 'channel') return false;
  if (!String(item.whatsapp_message_id || '').trim()) return false;
  const sentAt = String(item.sent_at || '').trim();
  if (!sentAt) return false;
  const sentMs = Date.parse(sentAt);
  if (!Number.isFinite(sentMs)) return false;
  const ageMs = Date.now() - sentMs;
  if (ageMs < 0) return false;
  return ageMs <= WHATSAPP_SENT_EDIT_WINDOW_MINUTES * 60 * 1000;
};

const QueuePage = () => {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [actionNotice, setActionNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const refreshQueueViews = () => {
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    queryClient.invalidateQueries({ queryKey: ['queue-stats'] });
    queryClient.invalidateQueries({ queryKey: ['logs'] });
    queryClient.invalidateQueries({ queryKey: ['feed-items'] });
  };

  const getMutationErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

  const { data: queueStats } = useQuery<QueueStats>({
    queryKey: ['queue-stats'],
    queryFn: () => api.get('/api/queue/stats?window_hours=24'),
    refetchInterval: 10000
  });

  const { data: queueItems = [], isLoading } = useQuery<QueueItem[]>({
    queryKey: ['queue', statusFilter],
    queryFn: () =>
      api.get(statusFilter === 'all' ? '/api/queue' : `/api/queue?status=${statusFilter}`),
    refetchInterval: 10000
  });

  const { data: shabbosStatus } = useQuery<ShabbosStatus>({
    queryKey: ['shabbos-status'],
    queryFn: () => api.get('/api/shabbos/status'),
    refetchInterval: 60000
  });

  const { data: outbox } = useQuery<WhatsAppOutbox>({
    queryKey: ['whatsapp-outbox'],
    queryFn: () => api.get('/api/whatsapp/outbox'),
    refetchInterval: 5000
  });

  const statusByMessageId = useMemo(() => {
    const map = new Map<string, WhatsAppOutboxStatus>();
    for (const status of outbox?.statuses || []) {
      if (!status?.id) continue;
      map.set(String(status.id), status);
    }
    return map;
  }, [outbox?.statuses]);

  const deleteItem = useMutation({
    mutationFn: (id: string) => api.delete(`/api/queue/${id}`),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Queue item removed.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Delete failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const clearPending = useMutation({
    mutationFn: () => api.delete('/api/queue/clear?status=pending'),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Queued items cleared.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Clear failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const retryFailed = useMutation({
    mutationFn: () => api.post('/api/queue/retry-failed'),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Failed items were moved back to queue.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Retry failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const resetProcessing = useMutation({
    mutationFn: () => api.post('/api/queue/reset-processing'),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Stuck sends were reset.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Reset failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const updateItem = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      api.patch(`/api/queue/${id}`, payload),
    onSuccess: () => {
      setEditingId(null);
      setDraftMessage('');
      setActionNotice({ type: 'success', message: 'Message text updated.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Save failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const pauseItem = useMutation({
    mutationFn: (id: string) => api.post(`/api/queue/${id}/pause`),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Delivery paused.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Pause failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const resumeItem = useMutation({
    mutationFn: (id: string) => api.post(`/api/queue/${id}/resume`),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Delivery resumed.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Resume failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const sendNowItem = useMutation({
    mutationFn: (id: string) => api.post<{ messageId?: string }>(`/api/queue/${id}/send-now`),
    onSuccess: (result: { messageId?: string }) => {
      setActionNotice({ type: 'success', message: result?.messageId ? `Sent now (${result.messageId}).` : 'Sent now.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Send now failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const pausePost = useMutation({
    mutationFn: (feedItemId: string) => api.post(`/api/feed-items/${feedItemId}/pause`),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Story queue paused.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Pause post failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const resumePost = useMutation({
    mutationFn: (feedItemId: string) => api.post(`/api/feed-items/${feedItemId}/resume`),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Story queue resumed.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Resume post failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const beginEdit = (item: QueueItem) => {
    setEditingId(item.id);
    setDraftMessage(item.rendered_content || deriveDefaultMessage(item));
  };

  const requestEdit = (item: QueueItem) => {
    if (!canEdit(item)) {
      const blockedStatus = String(item.status || 'unknown');
      setActionNotice({
        type: 'error',
        message: `Editing is available before send and for recently sent messages inside WhatsApp's 15-minute edit window. Current status: ${blockedStatus}.`
      });
      return;
    }
    beginEdit(item);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftMessage('');
  };

  const saveEdit = () => {
    if (!editingId) return;
    updateItem.mutate({
      id: editingId,
      payload: { message_content: draftMessage }
    });
  };

  const pauseReason = (item: QueueItem) => String(item.error_message || '').toLowerCase();

  const isItemPaused = (item: QueueItem) =>
    item.status === 'skipped' && pauseReason(item).includes('paused by user');

  const isPostPaused = (item: QueueItem) =>
    item.status === 'skipped' && pauseReason(item).includes('paused for this post');

  const isPaused = (item: QueueItem) => isItemPaused(item) || isPostPaused(item);

  const canEdit = (item: QueueItem) => {
    if (item.status === 'processing') return false;
    if (item.status === 'sent') return canEditSentInPlace(item);
    return true;
  };

  const canPause = (item: QueueItem) => item.status === 'pending' || item.status === 'failed';

  const canResume = (item: QueueItem) => isPaused(item) || item.status === 'failed';

  const canPausePost = (item: QueueItem) => Boolean(item.feed_item_id) && !isPostPaused(item);

  const canResumePost = (item: QueueItem) => Boolean(item.feed_item_id) && isPostPaused(item);

  const canToggleItemPause = (item: QueueItem) => canPause(item) || canResume(item);

  const canTogglePostPause = (item: QueueItem) => canPausePost(item) || canResumePost(item);

  const toggleItemPause = (item: QueueItem) => {
    if (canResume(item)) {
      resumeItem.mutate(item.id);
      return;
    }
    if (canPause(item)) {
      pauseItem.mutate(item.id);
    }
  };

  const togglePostPause = (item: QueueItem) => {
    if (!item.feed_item_id) return;
    if (canResumePost(item)) {
      resumePost.mutate(item.feed_item_id);
      return;
    }
    if (canPausePost(item)) {
      pausePost.mutate(item.feed_item_id);
    }
  };

  const canSendNow = (item: QueueItem) => item.status !== 'sent' && item.status !== 'processing';

  const getStatusBadge = (item: QueueItem) => {
    if (isPostPaused(item)) {
      return <Badge variant="secondary">Post paused</Badge>;
    }

    if (isPaused(item)) {
      return <Badge variant="secondary">Paused</Badge>;
    }

    switch (item.status) {
      case 'pending':
        return <Badge variant="secondary">Waiting to send</Badge>;
      case 'processing':
        return <Badge variant="warning">Sending now</Badge>;
      case 'sent':
        return <Badge variant="success">Sent</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed - will retry</Badge>;
      case 'skipped':
        return <Badge variant="warning">Skipped</Badge>;
      default:
        return <Badge variant="secondary">{item.status}</Badge>;
    }
  };

  const getReceiptBadge = (item: QueueItem) => {
    const messageId = String(item.whatsapp_message_id || '').trim();
    if (!messageId) {
      return null;
    }

    const snapshot = statusByMessageId.get(messageId);
    if (!snapshot) {
      return null;
    }

    const label = mapMessageStatusLabel(snapshot.status, snapshot.statusLabel);
    if (!label) {
      return null;
    }

    const lower = label.toLowerCase();
    if (lower === 'error') {
      return <Badge variant="destructive">Failed</Badge>;
    }
    if (lower === 'delivered' || lower === 'read' || lower === 'played') {
      return <Badge variant="success">Delivered</Badge>;
    }
    if (lower === 'pending' || lower === 'server') {
      return <Badge variant="warning">Sending...</Badge>;
    }
    return null;
  };

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString();
  };

  const getDeliveryPath = (item: QueueItem) => {
    const mediaType = String(item.media_type || '').toLowerCase();
    const mediaSent = Boolean(item.media_sent);

    if (item.status === 'sent') {
      if (mediaType === 'image' && mediaSent) {
        return { label: 'Sent as image', tone: 'success' as const };
      }
      if (mediaType === 'video' && mediaSent) {
        return { label: 'Sent as video', tone: 'success' as const };
      }
      if (mediaType && !mediaSent) {
        return { label: 'Sent as text (media fallback)', tone: 'warning' as const };
      }
      return { label: 'Sent as text/link', tone: 'secondary' as const };
    }

    if (item.image_url) {
      return { label: 'Will try image send', tone: 'secondary' as const };
    }

    return { label: 'Text/link send', tone: 'secondary' as const };
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Outgoing Queue</h1>
          <p className="text-muted-foreground">Review what is waiting to send, fix items, or send one right away.</p>
          <p className="text-xs text-muted-foreground">Queued items are shown in send order (oldest publish time first).</p>
          <p className="text-xs text-muted-foreground mt-1">Feed Items = fetched stories, Queue = editable pending sends, Logs = sent history.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => resetProcessing.mutate()}
            disabled={resetProcessing.isPending || !(queueStats?.processing ?? 0)}
            title={(queueStats?.processing ?? 0) > 0 ? 'Reset stuck processing items' : 'No processing items'}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${resetProcessing.isPending ? 'animate-spin' : ''}`} />
            Fix stuck sends
          </Button>
          <Button variant="outline" onClick={() => retryFailed.mutate()} disabled={retryFailed.isPending}>
            <RefreshCw className={`mr-2 h-4 w-4 ${retryFailed.isPending ? 'animate-spin' : ''}`} />
            Retry Failed
          </Button>
          <Button variant="destructive" onClick={() => clearPending.mutate()} disabled={clearPending.isPending}>
            <Trash2 className="mr-2 h-4 w-4" />
            Clear queued
          </Button>
        </div>
      </div>

      {shabbosStatus?.isShabbos && (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="rounded-full bg-warning/20 p-2">
              <AlertTriangle className="h-5 w-5 text-warning-foreground" />
            </div>
            <div className="flex-1">
              <p className="font-medium">Shabbos Mode Active</p>
              <p className="text-sm text-muted-foreground">Messages are held until {formatDate(shabbosStatus.endsAt)}</p>
            </div>
            <Badge variant="warning" className="px-3 py-1 text-sm">
              {shabbosStatus.reason}
            </Badge>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex shrink-0 bg-muted rounded-lg p-1">
          <Button
            variant={viewMode === 'list' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('list')}
            className="h-8"
          >
            <ListOrdered className="h-4 w-4 mr-2" />
            List
          </Button>
          <Button
            variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('grid')}
            className="h-8"
          >
            <LayoutGrid className="h-4 w-4 mr-2" />
            Grid
          </Button>
        </div>
        <Select value={statusFilter || 'all'} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full max-w-full sm:w-44">
            <SelectValue placeholder="Select status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Queued ({queueStats?.pending ?? 0})</SelectItem>
            <SelectItem value="processing">Sending ({queueStats?.processing ?? 0})</SelectItem>
            <SelectItem value="sent">Sent ({queueStats?.sent ?? 0})</SelectItem>
            <SelectItem value="failed">Failed ({queueStats?.failed ?? 0})</SelectItem>
            <SelectItem value="skipped">Skipped ({queueStats?.skipped ?? 0})</SelectItem>
            <SelectItem value="all">All ({queueStats?.total ?? 0})</SelectItem>
          </SelectContent>
        </Select>
        <span className="w-full text-sm text-muted-foreground sm:w-auto">
          {queueItems.length} item{queueItems.length !== 1 ? 's' : ''}
        </span>
      </div>

      {actionNotice ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            actionNotice.type === 'success'
              ? 'border-emerald-300/70 bg-emerald-50 text-emerald-900'
              : 'border-red-300/70 bg-red-50 text-red-900'
          }`}
        >
          {actionNotice.message}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {viewMode === 'list' ? <ListOrdered className="h-5 w-5" /> : <LayoutGrid className="h-5 w-5" />}
            {viewMode === 'list' ? 'Queued messages (List)' : 'Queued messages (Grid)'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : queueItems.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No messages in queue with status &quot;{statusFilter === 'all' ? 'any' : statusFilter}&quot;
            </div>
          ) : viewMode === 'list' ? (
            <div className="space-y-3">
              {queueItems.map((item, index) => {
                const mediaCandidate = item.media_url || item.image_url || null;
                const sentWithImage = item.status === 'sent' && item.media_type === 'image' && Boolean(item.media_sent);
                const imagePreview =
                  mediaCandidate && isSafeImageSrc(mediaCandidate) && (item.status !== 'sent' || sentWithImage)
                    ? mediaCandidate
                    : null;
                const editing = editingId === item.id;
                const receiptBadge = getReceiptBadge(item);
                const deliveryPath = getDeliveryPath(item);

                return (
                  <div key={item.id} className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          {getStatusBadge(item)}
                          {item.delivery_mode === 'batch' || item.delivery_mode === 'batched' ? (
                            <Badge variant="outline">Scheduled time</Badge>
                          ) : null}
                          {(statusFilter === 'pending' || statusFilter === 'processing') ? (
                            <Badge variant="outline">#{index + 1} in send order</Badge>
                          ) : null}
                          {item.target_name ? <Badge variant="outline">{item.target_name}</Badge> : null}
                          {item.target_type ? <Badge variant="secondary">{item.target_type}</Badge> : null}
                          <span className="text-xs text-muted-foreground">{item.schedule_name || 'Automation'}</span>
                        </div>
                        <p className="truncate font-medium">{item.title || 'No title'}</p>
                        <div className="mt-1 flex flex-wrap gap-2">
                          <Badge
                            variant={
                              deliveryPath.tone === 'success'
                                ? 'success'
                                : deliveryPath.tone === 'warning'
                                  ? 'warning'
                                  : 'secondary'
                            }
                          >
                            {deliveryPath.label}
                          </Badge>
                        </div>
                        {item.url ? (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-xs text-primary hover:underline"
                          >
                            {item.url}
                          </a>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => deleteItem.mutate(item.id)}
                        disabled={deleteItem.isPending}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    {imagePreview ? (
                      <a
                        href={imagePreview}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="relative block h-[180px] max-w-md overflow-hidden rounded-md border bg-muted/30"
                      >
                        <Image
                          src={imagePreview}
                          alt="Queue media"
                          fill
                          className="object-contain"
                          unoptimized
                        />
                      </a>
                    ) : null}

                    {editing ? (
                      <div className="space-y-2 rounded-md bg-muted p-3">
                        <p className="text-xs text-muted-foreground">Edit message text before sending</p>
                        <Textarea
                          value={draftMessage}
                          onChange={(event) => setDraftMessage(event.target.value)}
                          className="min-h-[96px]"
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={saveEdit} disabled={updateItem.isPending}>
                            {updateItem.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
                            Save
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelEdit}>
                            <X className="mr-1 h-3 w-3" /> Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (item.rendered_content || deriveDefaultMessage(item)) ? (
                      <div className="rounded-md bg-muted p-3">
                        <p className="mb-1 text-xs text-muted-foreground">Message</p>
                        <p className="line-clamp-3 whitespace-pre-wrap text-sm">{item.rendered_content || deriveDefaultMessage(item)}</p>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => requestEdit(item)}
                        title={canEdit(item) ? 'Edit message text (queued or recent sent in-place)' : 'Can edit queued items or recently sent items still inside WhatsApp edit window'}
                      >
                        <Pencil className="mr-1 h-3 w-3" /> Edit
                      </Button>

                      {canToggleItemPause(item) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => toggleItemPause(item)}
                          disabled={pauseItem.isPending || resumeItem.isPending}
                        >
                          {canResume(item) ? (
                            <PlayCircle className="mr-1 h-3 w-3" />
                          ) : (
                            <PauseCircle className="mr-1 h-3 w-3" />
                          )}
                          {canResume(item) ? 'Resume this target' : 'Pause this target'}
                        </Button>
                      ) : null}

                      {canTogglePostPause(item) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => togglePostPause(item)}
                          disabled={pausePost.isPending || resumePost.isPending}
                        >
                          {canResumePost(item) ? (
                            <PlayCircle className="mr-1 h-3 w-3" />
                          ) : (
                            <PauseCircle className="mr-1 h-3 w-3" />
                          )}
                          {canResumePost(item) ? 'Resume story (all targets)' : 'Pause story (all targets)'}
                        </Button>
                      ) : null}

                      <Button size="sm" variant="outline" onClick={() => sendNowItem.mutate(item.id)} disabled={!canSendNow(item) || sendNowItem.isPending}>
                        {sendNowItem.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
                        Send now
                      </Button>
                    </div>
                    {(canToggleItemPause(item) || canTogglePostPause(item)) ? (
                      <p className="text-[11px] text-muted-foreground">
                        Target pause changes one destination only. Story pause changes every destination for this story.
                      </p>
                    ) : null}

                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                      {item.pub_date ? <span>Published: {formatDate(item.pub_date)}</span> : null}
                      <span>Created: {formatDate(item.created_at)}</span>
                      {item.batch_times && item.batch_times.length ? <span>Send windows: {item.batch_times.join(', ')}</span> : null}
                      {item.scheduled_for ? <span>Scheduled: {formatDate(item.scheduled_for)}</span> : null}
                      {item.sent_at ? <span>Sent: {formatDate(item.sent_at)}</span> : null}
                      {item.sent_at && receiptBadge ? (
                        <span className="inline-flex items-center gap-1">
                          <span>Receipt:</span>
                          {receiptBadge}
                        </span>
                      ) : null}
                      {item.error_message ? <span className="text-destructive">Error: {item.error_message}</span> : null}
                      {item.status === 'sent' && item.media_type === 'image' && !item.media_sent && item.media_error ? (
                        <span className="text-warning-foreground">Sent as text fallback (image unavailable)</span>
                      ) : null}
                      {item.media_error && !item.error_message ? <span className="text-destructive">Media: {item.media_error}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {queueItems.map((item) => {
                const editing = editingId === item.id;
                const deliveryPath = getDeliveryPath(item);
                const mediaCandidate = item.media_url || item.image_url || null;
                const sentWithImage = item.status === 'sent' && item.media_type === 'image' && Boolean(item.media_sent);
                const showPreview =
                  Boolean(mediaCandidate) &&
                  isSafeImageSrc(mediaCandidate) &&
                  (item.status !== 'sent' || sentWithImage);
                return (
                <div key={item.id} className="relative flex flex-col rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden h-full">
                  <div className="relative aspect-video bg-muted/30">
                    {showPreview ? (
                        <Image
                          src={mediaCandidate || ''}
                          alt="Queue media"
                          fill
                          className="object-contain"
                          unoptimized
                        />
                    ) : (
                      <div className="flex h-full items-center justify-center text-muted-foreground">
                        <span className="text-xs">No media</span>
                      </div>
                    )}
                    <div className="absolute top-2 right-2 flex gap-1">
                      {getStatusBadge(item)}
                    </div>
                  </div>
                  <div className="p-3 flex-1 flex flex-col gap-2">
                    <div className="flex items-start justify-between">
                      <p className="font-medium text-sm truncate flex-1">{item.title || 'No title'}</p>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-destructive hover:text-destructive shrink-0"
                        onClick={() => deleteItem.mutate(item.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-3 flex-1">
                      {item.rendered_content || deriveDefaultMessage(item) || 'No content'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{deliveryPath.label}</p>
                    {item.pub_date ? <p className="text-[11px] text-muted-foreground">Published: {formatDate(item.pub_date)}</p> : null}
                    {editing ? (
                      <div className="rounded-md border bg-muted/30 p-2 space-y-2">
                        <p className="text-[11px] text-muted-foreground">Edit message text before sending</p>
                        <Textarea
                          value={draftMessage}
                          onChange={(event) => setDraftMessage(event.target.value)}
                          className="min-h-[88px] text-xs"
                        />
                        <div className="flex flex-wrap gap-1">
                          <Button size="sm" className="h-7 text-xs px-2" onClick={saveEdit} disabled={updateItem.isPending}>
                            {updateItem.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
                            Save
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs px-2" onClick={cancelEdit}>
                            <X className="mr-1 h-3 w-3" />
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-1 mt-auto pt-2">
                      {editing ? null : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2"
                          onClick={() => requestEdit(item)}
                          title={canEdit(item) ? 'Edit message text (queued or recent sent in-place)' : 'Can edit queued items or recently sent items still inside WhatsApp edit window'}
                        >
                          <Pencil className="mr-1 h-3 w-3" /> Edit
                        </Button>
                      )}
                      {canToggleItemPause(item) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2"
                          onClick={() => toggleItemPause(item)}
                          disabled={pauseItem.isPending || resumeItem.isPending}
                        >
                          {canResume(item) ? <PlayCircle className="mr-1 h-3 w-3" /> : <PauseCircle className="mr-1 h-3 w-3" />}
                          {canResume(item) ? 'Resume target' : 'Pause target'}
                        </Button>
                      )}
                      {canTogglePostPause(item) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2"
                          onClick={() => togglePostPause(item)}
                          disabled={pausePost.isPending || resumePost.isPending}
                          title={canResumePost(item) ? 'Resume this story for all targets' : 'Pause this story for all targets'}
                        >
                          {canResumePost(item) ? <PlayCircle className="mr-1 h-3 w-3" /> : <PauseCircle className="mr-1 h-3 w-3" />}
                          {canResumePost(item) ? 'Resume story (all)' : 'Pause story (all)'}
                        </Button>
                      )}
                      <Button size="sm" variant="outline" className="h-7 text-xs px-2 ml-auto" onClick={() => sendNowItem.mutate(item.id)} disabled={!canSendNow(item)}>
                        <Send className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              )})}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default QueuePage;
