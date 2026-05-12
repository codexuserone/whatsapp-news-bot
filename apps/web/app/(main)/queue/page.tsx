'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRuntimeStatus } from '@/lib/runtimeStatus';
import type { QueueItem, QueueStats, ShabbosStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
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
  LayoutGrid,
  Clock
} from 'lucide-react';

const SUCCESSFUL_SEND_STATUSES = new Set(['sent', 'delivered', 'read', 'played']);
const isSuccessfulSendStatus = (status: unknown) => SUCCESSFUL_SEND_STATUSES.has(String(status || '').toLowerCase());
const LIVE_QUEUE_STATUSES = new Set(['awaiting_approval', 'pending', 'processing']);
const HISTORY_STATUSES = new Set(['sent', 'delivered', 'read', 'played', 'failed', 'skipped', 'superseded']);

type NoticeType = 'success' | 'warning' | 'error';

type QueueSendNowResponse = {
  ok?: boolean;
  status?: string | null;
  messageId?: string | null;
  mediaSent?: boolean | null;
  error?: string | null;
};

const WHATSAPP_SENT_EDIT_MAX_MINUTES = 15;

const normalizeEditWindowMinutes = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return WHATSAPP_SENT_EDIT_MAX_MINUTES;
  return Math.min(Math.max(Math.floor(parsed), 1), WHATSAPP_SENT_EDIT_MAX_MINUTES);
};

const isSafeImageSrc = (value: unknown) => {
  const src = String(value || '').trim();
  if (!src) return false;
  if (src.startsWith('data:image/')) return true;
  if (src.startsWith('/')) return true;
  return src.startsWith('http://') || src.startsWith('https://');
};

const getMediaDisplayLabel = (item: QueueItem) => {
  const kind = String(item.media_type || item.media_kind || '').trim().toLowerCase();
  const hasMedia = Boolean(kind || item.media_url || item.image_url);
  if (!hasMedia) return 'Text only';
  if (item.media_sent && kind) return `${kind} sent`;
  if (item.media_error && kind) return `${kind} failed`;
  if (kind) return `${kind} attached`;
  return 'media attached';
};

const deriveDefaultMessage = (item: QueueItem) => {
  const title = String(item.title || '').trim();
  const url = String(item.url || '').trim();
  const chunks = [title, url].filter(Boolean);
  return chunks.join('\n\n');
};

const getSequenceStepLabel = (item: QueueItem) => {
  const explicit = String(item.sequence_step_label || '').trim();
  if (explicit) return explicit;
  const index = Number(item.sequence_step_index);
  if (Number.isFinite(index) && index > 0) return `Step ${index + 1}`;
  return '';
};

const canEditSentInPlace = (item: QueueItem, editWindowMinutes: number, nowMs?: number) => {
  if (!isSuccessfulSendStatus(item.status)) return false;
  if (item.target_type === 'status') return false;
  const mediaType = String(item.media_type || '').trim().toLowerCase();
  const mediaUrl = String(item.media_url || '').trim();
  if (mediaType || mediaUrl) {
    return false;
  }
  if (!String(item.whatsapp_message_id || '').trim()) return false;
  const sentAt = String(item.sent_at || '').trim();
  if (!sentAt) return false;
  const sentMs = Date.parse(sentAt);
  if (!Number.isFinite(sentMs)) return false;
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  const ageMs = now - sentMs;
  if (ageMs < 0) return false;
  return ageMs <= editWindowMinutes * 60 * 1000;
};

const QueueInner = () => {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [statusFilter, setStatusFilter] = useState('all');
  const [includeManual, setIncludeManual] = useState(() => String(searchParams?.get('include_manual') || '').toLowerCase() === 'true');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [showQueueTools, setShowQueueTools] = useState(false);
  const [actionNotice, setActionNotice] = useState<{ type: NoticeType; message: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { databaseUnavailable, databaseUnavailableMessage } = useRuntimeStatus();
  const databaseActionsBlocked = databaseUnavailable;

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { data: settings } = useQuery<{ post_send_edit_window_minutes?: number }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
    staleTime: 60000
  });
  const editWindowMinutes = normalizeEditWindowMinutes(settings?.post_send_edit_window_minutes);

  const refreshQueueViews = () => {
    queryClient.invalidateQueries({ queryKey: ['queue'] });
    queryClient.invalidateQueries({ queryKey: ['queue-stats'] });
    queryClient.invalidateQueries({ queryKey: ['logs'] });
    queryClient.invalidateQueries({ queryKey: ['feed-items'] });
  };

  const getMutationErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

  const { data: queueStats } = useQuery<QueueStats>({
    queryKey: ['queue-stats', includeManual],
    queryFn: () => api.get(`/api/queue/stats?window_hours=24&include_manual=${includeManual}`),
    refetchInterval: 30000
  });

  const retryableIssueCount = Number(queueStats?.failed || 0);
  const showingLiveQueueOnly = LIVE_QUEUE_STATUSES.has(statusFilter);
  const showingHistoryOnly = HISTORY_STATUSES.has(statusFilter);
  const queueCardTitle = showingLiveQueueOnly
    ? 'Live queue'
    : showingHistoryOnly
      ? 'Recent delivery results'
      : 'Live queue and recent results';
  const queueCardDescription = showingLiveQueueOnly
    ? 'Waiting and sending items.'
    : showingHistoryOnly
      ? 'Recent results.'
      : 'Queue and recent results.';

  const { data: queueItems = [], isLoading, error: queueError } = useQuery<QueueItem[]>({
    queryKey: ['queue', statusFilter, includeManual],
    queryFn: () =>
      api.get(
        statusFilter === 'all'
          ? `/api/queue?include_manual=${includeManual}`
          : `/api/queue?status=${statusFilter}&include_manual=${includeManual}`
      ),
    refetchInterval: 30000
  });
  const queueErrorMessage = queueError instanceof Error ? queueError.message : null;

  const { data: shabbosStatus } = useQuery<ShabbosStatus>({
    queryKey: ['shabbos-status'],
    queryFn: () => api.get('/api/shabbos/status'),
    refetchInterval: 60000
  });

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
    mutationFn: () => api.delete(`/api/queue/clear?status=pending&include_manual=${includeManual}`),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Queued items cleared.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Clear failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const retryFailed = useMutation({
    mutationFn: () => api.post(`/api/queue/retry-failed?include_manual=${includeManual}&window_hours=24`),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Recent issues were moved back to queue.' });
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
      setActionNotice({ type: 'success', message: 'Queue item updated.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Save failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const rescheduleItem = useMutation({
    mutationFn: ({ id, scheduledFor }: { id: string; scheduledFor: string | null }) =>
      api.patch(`/api/queue/${id}`, { scheduled_for: scheduledFor }),
    onSuccess: (_result, variables) => {
      setActionNotice({
        type: 'success',
        message: variables.scheduledFor ? 'Queue item delayed.' : 'Queue item moved back to the active queue.'
      });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Reschedule failed: ${getMutationErrorMessage(error)}` });
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
    mutationFn: (id: string) => api.post<QueueSendNowResponse>(`/api/queue/${id}/send-now`),
    onSuccess: (result: QueueSendNowResponse) => {
      if (result?.ok) {
        setActionNotice({ type: 'success', message: result?.messageId ? `Sent now (${result.messageId}).` : 'Sent now.' });
      } else if (String(result?.status || '').toLowerCase() === 'awaiting_approval') {
        setActionNotice({ type: 'warning', message: result?.error || 'Held for review before another send attempt.' });
      } else {
        setActionNotice({ type: 'error', message: result?.error || 'Send now did not complete.' });
      }
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Send now failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const approveItem = useMutation({
    mutationFn: (id: string) => api.post(`/api/queue/${id}/approve`),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Approved. Item is now queued to send.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Approve failed: ${getMutationErrorMessage(error)}` });
    }
  });

  const rejectItem = useMutation({
    mutationFn: (id: string) => api.post(`/api/queue/${id}/reject`),
    onSuccess: () => {
      setActionNotice({ type: 'success', message: 'Rejected. Item was skipped.' });
      refreshQueueViews();
    },
    onError: (error: unknown) => {
      setActionNotice({ type: 'error', message: `Reject failed: ${getMutationErrorMessage(error)}` });
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
    if (databaseActionsBlocked) {
      setActionNotice({
        type: 'error',
        message: databaseUnavailableMessage || 'Database is unavailable. Queue edits are paused.'
      });
      return;
    }
    if (!canEdit(item)) {
      const blockedStatus = String(item.status || 'unknown');
      setActionNotice({
        type: 'error',
        message: `Editing is available before send. Recently sent text-only messages can be edited inside WhatsApp's ${editWindowMinutes}-minute edit window. Current status: ${blockedStatus}.`
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
    if (databaseActionsBlocked) {
      setActionNotice({
        type: 'error',
        message: databaseUnavailableMessage || 'Database is unavailable. Queue edits are paused.'
      });
      return;
    }
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
    if (databaseActionsBlocked) return false;
    if (item.status === 'processing') return false;
    if (isSuccessfulSendStatus(item.status)) return canEditSentInPlace(item, editWindowMinutes, nowMs);
    return true;
  };

  const canPause = (item: QueueItem) =>
    !databaseActionsBlocked &&
    (item.status === 'awaiting_approval' || item.status === 'pending' || item.status === 'failed');

  const canResume = (item: QueueItem) =>
    !databaseActionsBlocked && (isPaused(item) || item.status === 'failed');

  const canPausePost = (item: QueueItem) => !databaseActionsBlocked && Boolean(item.feed_item_id) && !isPostPaused(item);

  const canResumePost = (item: QueueItem) => !databaseActionsBlocked && Boolean(item.feed_item_id) && isPostPaused(item);

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

  const canSendNow = (item: QueueItem) =>
    !databaseActionsBlocked &&
    !isSuccessfulSendStatus(item.status) &&
    item.status !== 'processing' &&
    item.status !== 'skipped' &&
    !isPaused(item) &&
    !isPostPaused(item);

  const canReschedule = (item: QueueItem) =>
    !databaseActionsBlocked &&
    ['awaiting_approval', 'pending', 'failed'].includes(String(item.status || '').toLowerCase()) &&
    !isPaused(item) &&
    !isPostPaused(item);

  const delayItem = (item: QueueItem, minutes: number) => {
    const scheduledFor = new Date(nowMs + Math.max(1, minutes) * 60 * 1000).toISOString();
    rescheduleItem.mutate({ id: item.id, scheduledFor });
  };

  const clearDelay = (item: QueueItem) => {
    rescheduleItem.mutate({ id: item.id, scheduledFor: null });
  };

  const getStatusBadge = (item: QueueItem) => {
    if (isPostPaused(item)) {
      return <Badge variant="secondary">Post paused</Badge>;
    }

    if (isPaused(item)) {
      return <Badge variant="secondary">Paused</Badge>;
    }

    switch (item.status) {
      case 'awaiting_approval':
        return <Badge variant="warning">Held</Badge>;
      case 'pending':
        return <Badge variant="secondary">Queued</Badge>;
      case 'processing':
        return <Badge variant="warning">Sending</Badge>;
      case 'sent':
        return <Badge variant="success">Sent to WhatsApp</Badge>;
      case 'delivered':
      case 'read':
      case 'played':
        return <Badge variant="success">Sent</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      case 'skipped':
        return <Badge variant="warning">Skipped</Badge>;
      default:
        return <Badge variant="secondary">{item.status}</Badge>;
    }
  };

  const getCorrectionBadge = (item: QueueItem) => {
    const correctionKind = String(item.correction_kind || '').trim().toLowerCase();
    const correctionError = String(item.correction_error || '').trim();
    if (correctionError) {
      return <Badge variant="destructive">Correction failed</Badge>;
    }
    const hasCorrection = Boolean(correctionKind || String(item.corrected_at || '').trim());
    if (!hasCorrection) {
      return null;
    }

    switch (correctionKind) {
      case 'pending_refresh':
        return <Badge variant="outline">Updated from feed</Badge>;
      case 'edit':
        return <Badge variant="outline">Edited after send</Badge>;
      case 'replacement':
        return <Badge variant="outline">Replaced after send</Badge>;
      case 'manual_edit':
        return <Badge variant="outline">Edited manually</Badge>;
      default:
        return <Badge variant="outline">Corrected</Badge>;
    }
  };

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString();
  };

  const formatPublishedDate = (dateStr?: string | null, precision?: string | null) => {
    if (!dateStr) return '-';
    const parsed = new Date(dateStr);
    if (!Number.isFinite(parsed.getTime())) return '-';
    const normalizedPrecision = String(precision || '').toLowerCase();
    const dateOnlyByValue = /t00:00(?::00(?:\.\d+)?)?(?:z|[+-]\d{2}:\d{2})$/i.test(String(dateStr));
    if (normalizedPrecision === 'date' || (!normalizedPrecision && dateOnlyByValue)) {
      return `${parsed.toLocaleDateString()} (date only from source)`;
    }
    return parsed.toLocaleString();
  };

  const getDeliveryPath = (item: QueueItem) => {
    const mediaType = String(item.media_type || '').toLowerCase();
    const mediaSent = Boolean(item.media_sent);
    const hasRequestedMedia = Boolean(mediaType || item.media_url || item.image_url);

    if (isSuccessfulSendStatus(item.status)) {
      if (mediaSent && mediaType) {
        return { label: `Sent with ${mediaType}`, tone: 'success' as const };
      }
      if (mediaType && !mediaSent) {
        return item.media_error
          ? { label: `Sent text/link; ${mediaType} not sent`, tone: 'warning' as const }
          : { label: 'Sent text-only', tone: 'warning' as const };
      }
      return { label: 'Sent text-only', tone: 'secondary' as const };
    }

    if (item.status === 'awaiting_approval') {
      return hasRequestedMedia
        ? { label: 'Held with media', tone: 'warning' as const }
        : { label: 'Held', tone: 'warning' as const };
    }

    const plannedKind = String(item.media_kind || item.media_type || '').toLowerCase();
    if (plannedKind === 'image' || item.image_url) {
      return { label: 'Queued with image', tone: 'secondary' as const };
    }
    if (plannedKind === 'video') {
      return { label: 'Queued with video', tone: 'secondary' as const };
    }
    if (plannedKind === 'audio') {
      return { label: 'Queued with audio', tone: 'secondary' as const };
    }
    if (plannedKind === 'document') {
      return { label: 'Queued with document', tone: 'secondary' as const };
    }

    return { label: 'Queued text-only', tone: 'secondary' as const };
  };

  const getTargetStateBadge = (item: QueueItem) => {
    if (item.target_active === false) return <Badge variant="warning">Inactive target</Badge>;
    if (item.target_in_current_schedule === false) return <Badge variant="outline">Old target</Badge>;
    return null;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Outgoing Queue</h1>
          <p className="text-muted-foreground">Review, edit, pause, retry, or send queued items.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setShowQueueTools((current) => !current)}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Queue tools
          </Button>
        </div>
      </div>

      {showQueueTools ? (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle>Queue tools</CardTitle>
            <p className="text-sm text-muted-foreground">
              Use these only when a send is visibly stuck or a failed item should be tried again.
            </p>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => resetProcessing.mutate()}
              disabled={databaseActionsBlocked || resetProcessing.isPending || !(queueStats?.processing ?? 0)}
              title={
                databaseActionsBlocked
                  ? 'Database unavailable; queue actions are paused'
                  : (queueStats?.processing ?? 0) > 0
                    ? 'Move currently stuck sending items back to the queue'
                    : 'No sending items are stuck'
              }
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${resetProcessing.isPending ? 'animate-spin' : ''}`} />
              Reset stuck sends
            </Button>
            <Button
              variant="outline"
              onClick={() => retryFailed.mutate()}
              disabled={databaseActionsBlocked || retryFailed.isPending || !retryableIssueCount}
              title={
                databaseActionsBlocked
                  ? 'Database unavailable; retry is paused'
                  : retryableIssueCount
                    ? 'Move recent failed sends back to the queue'
                    : 'No recent failed sends to retry'
              }
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${retryFailed.isPending ? 'animate-spin' : ''}`} />
              Retry failed sends
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!window.confirm('Clear every currently queued item in this view? Sent history will not be deleted.')) return;
                clearPending.mutate();
              }}
              disabled={databaseActionsBlocked || clearPending.isPending}
              title={databaseActionsBlocked ? 'Database unavailable; queue actions are paused' : undefined}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Clear queued items
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {databaseActionsBlocked ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-start gap-3 pt-6">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">Queue actions are paused</p>
              <p className="text-sm text-muted-foreground">
                {databaseUnavailableMessage || 'The database is unavailable, so queue edits and send-now actions are paused.'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

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
              <SelectItem value="awaiting_approval">Awaiting approval ({queueStats?.awaiting_approval ?? 0})</SelectItem>
              <SelectItem value="pending">Queued ({queueStats?.pending ?? 0})</SelectItem>
              <SelectItem value="processing">Attempting send ({queueStats?.processing ?? 0})</SelectItem>
              <SelectItem value="sent">Sent to WhatsApp ({queueStats?.sent ?? 0})</SelectItem>
              <SelectItem value="failed">Failed ({queueStats?.failed ?? 0})</SelectItem>
              <SelectItem value="skipped">Skipped ({queueStats?.skipped ?? 0})</SelectItem>
              <SelectItem value="all">All ({queueStats?.total ?? 0})</SelectItem>
            </SelectContent>
        </Select>
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <Switch id="include-manual" checked={includeManual} onCheckedChange={setIncludeManual} />
          <Label htmlFor="include-manual" className="text-sm">
            Include manual
          </Label>
        </div>
        <span className="w-full text-sm text-muted-foreground sm:w-auto">
          {queueItems.length} item{queueItems.length !== 1 ? 's' : ''}
        </span>
      </div>

      {actionNotice ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${actionNotice.type === 'success'
              ? 'border-emerald-300/70 bg-emerald-50 text-emerald-900'
              : actionNotice.type === 'warning'
                ? 'border-amber-300/70 bg-amber-50 text-amber-900'
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
            {viewMode === 'list' ? `${queueCardTitle} (List)` : `${queueCardTitle} (Grid)`}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{queueCardDescription}</p>
        </CardHeader>
        <CardContent>
          {queueErrorMessage ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">Queue data is temporarily unavailable</div>
                  <div className="mt-1 text-xs text-amber-100/80">{queueErrorMessage}</div>
                </div>
              </div>
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : queueItems.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No rows found for &quot;{statusFilter === 'all' ? 'all statuses' : statusFilter}&quot;.
            </div>
          ) : viewMode === 'list' ? (
            <div className="space-y-3">
              {queueItems.map((item, index) => {
                const mediaCandidate = item.media_url || item.image_url || null;
                const sentWithImage =
                  isSuccessfulSendStatus(item.status) && item.media_type === 'image' && Boolean(item.media_sent);
                const imagePreview =
                  mediaCandidate &&
                    isSafeImageSrc(mediaCandidate) &&
                    (!isSuccessfulSendStatus(item.status) || sentWithImage)
                    ? mediaCandidate
                    : null;
                const editing = editingId === item.id;
                const deliveryPath = getDeliveryPath(item);
                const editRemainingMs = (() => {
                  if (!canEditSentInPlace(item, editWindowMinutes, nowMs)) return null;
                  const sentAt = String(item.sent_at || '').trim();
                  if (!sentAt) return null;
                  const sentMs = Date.parse(sentAt);
                  if (!Number.isFinite(sentMs)) return null;
                  const remaining = editWindowMinutes * 60 * 1000 - (nowMs - sentMs);
                  return remaining > 0 ? remaining : null;
                })();
                const editCountdown = editRemainingMs
                  ? `${Math.floor(Math.ceil(editRemainingMs / 1000) / 60)}:${String(
                    Math.ceil(editRemainingMs / 1000) % 60
                  ).padStart(2, '0')}`
                  : null;
                const correctionBadge = getCorrectionBadge(item);
                const sequenceStepLabel = getSequenceStepLabel(item);
                const targetStateBadge = getTargetStateBadge(item);

                return (
                  <div key={item.id} className="space-y-3 rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          {getStatusBadge(item)}
                          {item.delivery_mode === 'batch' || item.delivery_mode === 'batched' ? (
                            <Badge variant="outline">Scheduled time</Badge>
                          ) : null}
                          {sequenceStepLabel ? <Badge variant="outline">{sequenceStepLabel}</Badge> : null}
                          {(statusFilter === 'pending' || statusFilter === 'processing') ? (
                            <Badge variant="outline">#{index + 1} in queue view</Badge>
                          ) : null}
                          {item.target_name ? <Badge variant="outline">{item.target_name}</Badge> : null}
                          {targetStateBadge}
                          <span className="text-xs text-muted-foreground">
                            {item.is_manual ? 'Manual' : item.schedule_name || 'Schedule'}
                          </span>
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
                          <Badge variant="outline">{getMediaDisplayLabel(item)}</Badge>
                          {correctionBadge}
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
                        disabled={databaseActionsBlocked || deleteItem.isPending}
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
                        <p className="text-xs text-muted-foreground">Edit queued content. Recently sent text-only messages can be edited inside WhatsApp&apos;s edit window.</p>
                        <Textarea
                          value={draftMessage}
                          onChange={(event) => setDraftMessage(event.target.value)}
                          className="min-h-[96px]"
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={saveEdit} disabled={databaseActionsBlocked || updateItem.isPending}>
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
                        disabled={!canEdit(item)}
                        title={canEdit(item) ? 'Edit queued content or a recent text-only WhatsApp message' : 'Can edit queued items, plus recent text-only WhatsApp messages still inside the edit window'}
                      >
                        <Pencil className="mr-1 h-3 w-3" /> Edit
                      </Button>

                      {item.status === 'awaiting_approval' ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => approveItem.mutate(item.id)}
                            disabled={databaseActionsBlocked || approveItem.isPending}
                          >
                            <PlayCircle className="mr-1 h-3 w-3" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => rejectItem.mutate(item.id)}
                            disabled={databaseActionsBlocked || rejectItem.isPending}
                          >
                            <X className="mr-1 h-3 w-3" /> Reject
                          </Button>
                        </>
                      ) : null}

                      {canToggleItemPause(item) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => toggleItemPause(item)}
                          disabled={databaseActionsBlocked || pauseItem.isPending || resumeItem.isPending}
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
                          disabled={databaseActionsBlocked || pausePost.isPending || resumePost.isPending}
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

                      {canReschedule(item) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => delayItem(item, 10)}
                          disabled={databaseActionsBlocked || rescheduleItem.isPending}
                        >
                          <Clock className="mr-1 h-3 w-3" /> Delay 10m
                        </Button>
                      ) : null}

                      {canReschedule(item) && item.scheduled_for ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => clearDelay(item)}
                          disabled={databaseActionsBlocked || rescheduleItem.isPending}
                        >
                          <Clock className="mr-1 h-3 w-3" /> Clear delay
                        </Button>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                      {item.pub_date ? <span>Published: {formatPublishedDate(item.pub_date, item.pub_precision)}</span> : null}
                      <span>Created: {formatDate(item.created_at)}</span>
                      {item.batch_times && item.batch_times.length ? <span>Send windows: {item.batch_times.join(', ')}</span> : null}
                      {item.scheduled_for ? <span>Scheduled: {formatDate(item.scheduled_for)}</span> : null}
                      {item.sent_at ? <span>Sent: {formatDate(item.sent_at)}</span> : null}
                      {item.corrected_at ? <span>Corrected: {formatDate(item.corrected_at)}</span> : null}
                      {editCountdown ? <span>Editable: {editCountdown} left</span> : null}
                      {item.error_message ? <span className="text-destructive">Error: {item.error_message}</span> : null}
                      {item.correction_error ? <span className="text-warning-foreground">Correction: {item.correction_error}</span> : null}
                      {isSuccessfulSendStatus(item.status) && item.media_type === 'image' && !item.media_sent && item.media_error ? (
                        <span className="text-warning-foreground">Sent text-only; requested image was not sent</span>
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
                const correctionBadge = getCorrectionBadge(item);
                const mediaCandidate = item.media_url || item.image_url || null;
                const sentWithImage =
                  isSuccessfulSendStatus(item.status) && item.media_type === 'image' && Boolean(item.media_sent);
                const showPreview =
                  Boolean(mediaCandidate) &&
                  isSafeImageSrc(mediaCandidate) &&
                  (!isSuccessfulSendStatus(item.status) || sentWithImage);
                const sequenceStepLabel = getSequenceStepLabel(item);
                const targetStateBadge = getTargetStateBadge(item);
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
                          <span className="px-3 text-center text-xs">{getMediaDisplayLabel(item)}</span>
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
                          disabled={databaseActionsBlocked || deleteItem.isPending}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-3 flex-1">
                        {item.rendered_content || deriveDefaultMessage(item) || 'No content'}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{deliveryPath.label}</p>
                      {sequenceStepLabel ? <Badge variant="outline" className="w-fit">{sequenceStepLabel}</Badge> : null}
                      {targetStateBadge ? <div className="flex flex-wrap gap-1">{targetStateBadge}</div> : null}
                      {correctionBadge ? <div className="flex flex-wrap gap-1">{correctionBadge}</div> : null}
                      {item.pub_date ? <p className="text-[11px] text-muted-foreground">Published: {formatPublishedDate(item.pub_date, item.pub_precision)}</p> : null}
                      {item.sent_at ? <p className="text-[11px] text-muted-foreground">Sent: {formatDate(item.sent_at)}</p> : null}
                      {item.corrected_at ? <p className="text-[11px] text-muted-foreground">Corrected: {formatDate(item.corrected_at)}</p> : null}
                      {item.correction_error ? <p className="text-[11px] text-warning-foreground">Correction: {item.correction_error}</p> : null}
                      {editing ? (
                        <div className="rounded-md border bg-muted/30 p-2 space-y-2">
                          <p className="text-[11px] text-muted-foreground">Edit queued content. Recently sent text-only messages can be edited inside WhatsApp&apos;s edit window.</p>
                          <Textarea
                            value={draftMessage}
                            onChange={(event) => setDraftMessage(event.target.value)}
                            className="min-h-[88px] text-xs"
                          />
                          <div className="flex flex-wrap gap-1">
                            <Button size="sm" className="h-7 text-xs px-2" onClick={saveEdit} disabled={databaseActionsBlocked || updateItem.isPending}>
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
                            disabled={!canEdit(item)}
                            title={canEdit(item) ? 'Edit queued content or a recent text-only WhatsApp message' : 'Can edit queued items, plus recent text-only WhatsApp messages still inside the edit window'}
                          >
                            <Pencil className="mr-1 h-3 w-3" /> Edit
                          </Button>
                        )}
                        {item.status === 'awaiting_approval' ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2"
                              onClick={() => approveItem.mutate(item.id)}
                              disabled={databaseActionsBlocked || approveItem.isPending}
                            >
                              <PlayCircle className="mr-1 h-3 w-3" />
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2"
                              onClick={() => rejectItem.mutate(item.id)}
                              disabled={databaseActionsBlocked || rejectItem.isPending}
                            >
                              <X className="mr-1 h-3 w-3" />
                              Reject
                            </Button>
                          </>
                        ) : null}
                        {canToggleItemPause(item) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs px-2"
                            onClick={() => toggleItemPause(item)}
                            disabled={databaseActionsBlocked || pauseItem.isPending || resumeItem.isPending}
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
                            disabled={databaseActionsBlocked || pausePost.isPending || resumePost.isPending}
                            title={canResumePost(item) ? 'Resume this story for all targets' : 'Pause this story for all targets'}
                          >
                            {canResumePost(item) ? <PlayCircle className="mr-1 h-3 w-3" /> : <PauseCircle className="mr-1 h-3 w-3" />}
                            {canResumePost(item) ? 'Resume story (all)' : 'Pause story (all)'}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="h-7 text-xs px-2 ml-auto" onClick={() => sendNowItem.mutate(item.id)} disabled={!canSendNow(item) || sendNowItem.isPending}>
                          <Send className="h-3 w-3" />
                        </Button>
                        {canReschedule(item) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs px-2"
                            onClick={() => item.scheduled_for ? clearDelay(item) : delayItem(item, 10)}
                            disabled={databaseActionsBlocked || rescheduleItem.isPending}
                          >
                            <Clock className="h-3 w-3" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

const QueuePage = () => {
  return (
    <Suspense
      fallback={
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Queue</h1>
          <p className="text-muted-foreground">Loading queue...</p>
        </div>
      }
    >
      <QueueInner />
    </Suspense>
  );
};

export default QueuePage;
