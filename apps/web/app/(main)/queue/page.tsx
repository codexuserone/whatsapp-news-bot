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
  Send
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

const QueuePage = () => {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('pending');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState('');

  const refreshQueueViews = () => {
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    queryClient.invalidateQueries({ queryKey: ['queue-stats'] });
    queryClient.invalidateQueries({ queryKey: ['logs'] });
    queryClient.invalidateQueries({ queryKey: ['feed-items'] });
  };

  const { data: queueStats } = useQuery<QueueStats>({
    queryKey: ['queue-stats'],
    queryFn: () => api.get('/api/queue/stats'),
    refetchInterval: 10000
  });

  const effectiveStatusFilter =
    statusFilter === 'pending' && (queueStats?.pending ?? 0) === 0 && (queueStats?.sent ?? 0) > 0
      ? 'sent'
      : statusFilter;

  const { data: queueItems = [], isLoading } = useQuery<QueueItem[]>({
    queryKey: ['queue', effectiveStatusFilter],
    queryFn: () =>
      api.get(effectiveStatusFilter === 'all' ? '/api/queue' : `/api/queue?status=${effectiveStatusFilter}`),
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
    onSuccess: refreshQueueViews
  });

  const clearPending = useMutation({
    mutationFn: () => api.delete('/api/queue/clear?status=pending'),
    onSuccess: refreshQueueViews
  });

  const retryFailed = useMutation({
    mutationFn: () => api.post('/api/queue/retry-failed'),
    onSuccess: refreshQueueViews
  });

  const resetProcessing = useMutation({
    mutationFn: () => api.post('/api/queue/reset-processing'),
    onSuccess: refreshQueueViews
  });

  const updateItem = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      api.patch(`/api/queue/${id}`, payload),
    onSuccess: () => {
      setEditingId(null);
      setDraftMessage('');
      refreshQueueViews();
    }
  });

  const pauseItem = useMutation({
    mutationFn: (id: string) => api.post(`/api/queue/${id}/pause`),
    onSuccess: refreshQueueViews
  });

  const resumeItem = useMutation({
    mutationFn: (id: string) => api.post(`/api/queue/${id}/resume`),
    onSuccess: refreshQueueViews
  });

  const sendNowItem = useMutation({
    mutationFn: (id: string) => api.post(`/api/queue/${id}/send-now`),
    onSuccess: refreshQueueViews
  });

  const beginEdit = (item: QueueItem) => {
    setEditingId(item.id);
    setDraftMessage(item.rendered_content || '');
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

  const isPaused = (item: QueueItem) =>
    item.status === 'skipped' && String(item.error_message || '').toLowerCase().includes('paused by user');

  const canEdit = (item: QueueItem) => item.status === 'pending' || item.status === 'failed' || isPaused(item);

  const canPause = (item: QueueItem) => item.status === 'pending' || item.status === 'failed';

  const canResume = (item: QueueItem) => isPaused(item) || item.status === 'failed';

  const canSendNow = (item: QueueItem) => item.status !== 'sent' && item.status !== 'processing';

  const getStatusBadge = (item: QueueItem) => {
    if (isPaused(item)) {
      return <Badge variant="secondary">Paused</Badge>;
    }

    switch (item.status) {
      case 'pending':
        return <Badge variant="secondary">Queued</Badge>;
      case 'processing':
        return <Badge variant="warning">Sending</Badge>;
      case 'sent':
        return <Badge variant="success">Sent</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      case 'skipped':
        return <Badge variant="warning">Skipped</Badge>;
      default:
        return <Badge variant="secondary">{item.status}</Badge>;
    }
  };

  const getReceiptBadge = (item: QueueItem) => {
    const messageId = String(item.whatsapp_message_id || '').trim();
    if (!messageId) {
      if (item.status === 'sent') {
        return <Badge variant="warning">Receipt unknown</Badge>;
      }
      return null;
    }

    const snapshot = statusByMessageId.get(messageId);
    if (!snapshot) {
      if (item.status === 'sent') {
        return <Badge variant="warning">Not observed yet</Badge>;
      }
      return null;
    }

    const label = mapMessageStatusLabel(snapshot.status, snapshot.statusLabel);
    if (!label) {
      return <Badge variant="secondary">Observed</Badge>;
    }

    const lower = label.toLowerCase();
    if (lower === 'error') {
      return <Badge variant="destructive">{label}</Badge>;
    }
    if (lower === 'delivered' || lower === 'read' || lower === 'played') {
      return <Badge variant="success">{label}</Badge>;
    }
    if (lower === 'pending' || lower === 'server') {
      return <Badge variant="warning">{label}</Badge>;
    }
    return <Badge variant="secondary">{label}</Badge>;
  };

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Outgoing Queue</h1>
          <p className="text-muted-foreground">Review what is waiting to send, fix items, or send one right away.</p>
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

      <div className="flex items-center gap-4">
        <Select value={effectiveStatusFilter === '' ? 'all' : effectiveStatusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44">
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
        <span className="text-sm text-muted-foreground">{queueItems.length} item{queueItems.length !== 1 ? 's' : ''}</span>
      </div>

      {statusFilter === 'pending' && !isLoading && queueItems.length === 0 && (queueStats?.sent || 0) > 0 && (
        <div className="text-sm text-muted-foreground">
          Nothing queued right now. Switch to <span className="font-medium">Sent</span> to see delivery history.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ListOrdered className="h-5 w-5" />
            Queued messages
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : queueItems.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No messages in queue with status &quot;{effectiveStatusFilter === 'all' ? 'any' : effectiveStatusFilter}&quot;
            </div>
          ) : (
            <div className="space-y-3">
              {queueItems.map((item) => {
                const imagePreview = item.media_url || item.image_url || null;
                const editing = editingId === item.id;

                return (
                  <div key={item.id} className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          {getStatusBadge(item)}
                          {item.delivery_mode === 'batch' || item.delivery_mode === 'batched' ? (
                            <Badge variant="outline">Batch</Badge>
                          ) : (
                            <Badge variant="outline">Immediate</Badge>
                          )}
                          {item.target_name ? <Badge variant="outline">{item.target_name}</Badge> : null}
                          {item.target_type ? <Badge variant="secondary">{item.target_type}</Badge> : null}
                          <span className="text-xs text-muted-foreground">{item.schedule_name || 'Automation'}</span>
                        </div>
                        <p className="truncate font-medium">{item.title || 'No title'}</p>
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
                        className="block overflow-hidden rounded-md border bg-muted/30"
                      >
                        <Image
                          src={imagePreview}
                          alt="Queue media"
                          width={960}
                          height={540}
                          unoptimized
                          className="h-36 w-full object-cover"
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
                    ) : item.rendered_content ? (
                      <div className="rounded-md bg-muted p-3">
                        <p className="mb-1 text-xs text-muted-foreground">Message</p>
                        <p className="line-clamp-3 whitespace-pre-wrap text-sm">{item.rendered_content}</p>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => beginEdit(item)} disabled={!canEdit(item)}>
                        <Pencil className="mr-1 h-3 w-3" /> Edit
                      </Button>

                      {canPause(item) ? (
                        <Button size="sm" variant="outline" onClick={() => pauseItem.mutate(item.id)} disabled={pauseItem.isPending}>
                          <PauseCircle className="mr-1 h-3 w-3" /> Pause
                        </Button>
                      ) : null}

                      {canResume(item) ? (
                        <Button size="sm" variant="outline" onClick={() => resumeItem.mutate(item.id)} disabled={resumeItem.isPending}>
                          <PlayCircle className="mr-1 h-3 w-3" /> Resume
                        </Button>
                      ) : null}

                      <Button size="sm" variant="outline" onClick={() => sendNowItem.mutate(item.id)} disabled={!canSendNow(item) || sendNowItem.isPending}>
                        {sendNowItem.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
                        Send now
                      </Button>
                    </div>

                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                      <span>Created: {formatDate(item.created_at)}</span>
                      {item.batch_times && item.batch_times.length ? <span>Send windows: {item.batch_times.join(', ')}</span> : null}
                      {item.scheduled_for ? <span>Scheduled: {formatDate(item.scheduled_for)}</span> : null}
                      {item.sent_at ? <span>Sent: {formatDate(item.sent_at)}</span> : null}
                      {item.sent_at ? (
                        <span className="inline-flex items-center gap-1">
                          <span>Receipt:</span>
                          {getReceiptBadge(item) || <Badge variant="secondary">Unknown</Badge>}
                        </span>
                      ) : null}
                      {item.error_message ? <span className="text-destructive">Error: {item.error_message}</span> : null}
                      {item.media_error && !item.error_message ? <span className="text-destructive">Media: {item.media_error}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default QueuePage;
