'use client';

import React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BackendSettings, Target, WhatsAppQrState, WhatsAppStatus, WhatsAppStatusAudience } from '@/lib/types';
import { dedupeTargets, formatTargetLabel } from '@/lib/targetUtils';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Power, CheckCircle, QrCode, Loader2, Send, MessageSquare, RadioTower } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';

type SendTestPayload = {
  jid?: string;
  jids?: string[];
  statusJidList?: string[];
  message?: string;
  linkUrl?: string;
  imageUrl?: string;
  audioUrl?: string;
  documentUrl?: string;
  imageDataUrl?: string;
  videoDataUrl?: string;
  audioDataUrl?: string;
  documentDataUrl?: string;
  documentFilename?: string;
  documentMime?: string;
  includeCaption?: boolean;
  disableLinkPreview?: boolean;
  confirm?: boolean;
};

type SendTestResponse = {
  ok: boolean;
  messageId?: string | null;
  sent?: number;
  confirmed?: number;
  uncertain?: number;
  failed?: number;
  results?: Array<{
    jid: string;
    ok: boolean;
    messageId?: string | null;
    confirmed?: boolean;
    error?: string;
  }>;
  confirmation?: {
    ok: boolean;
    via?: string;
    status?: number | null;
    statusLabel?: string | null;
  } | null;
};

const isSafeImageSrc = (value: unknown) => {
  const src = String(value || '').trim();
  if (!src) return false;
  if (src.startsWith('data:image/')) return true;
  if (src.startsWith('/')) return true;
  return src.startsWith('http://') || src.startsWith('https://');
};

const formatQrCountdown = (remainingMs: number | null | undefined) => {
  if (!Number.isFinite(remainingMs) || Number(remainingMs) <= 0) {
    return 'Refreshing QR...';
  }
  const totalSeconds = Math.ceil(Number(remainingMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `Expires in ${seconds}s`;
  }
  return `Expires in ${minutes}m ${seconds}s`;
};

const WhatsAppPage = () => {
  const queryClient = useQueryClient();
  const [selectedTargets, setSelectedTargets] = React.useState<string[]>([]);
  const [testMessage, setTestMessage] = React.useState('');
  const [attachMedia, setAttachMedia] = React.useState(false);
  const [includeTextWithMedia, setIncludeTextWithMedia] = React.useState(true);
  const [disableLinkPreview, setDisableLinkPreview] = React.useState(false);
  const [attachmentDataUrl, setAttachmentDataUrl] = React.useState('');
  const [attachmentMimeType, setAttachmentMimeType] = React.useState('');
  const [attachmentName, setAttachmentName] = React.useState('');
  const [showAdvancedRecovery, setShowAdvancedRecovery] = React.useState(false);
  const [qrTickMs, setQrTickMs] = React.useState<number | null>(null);
  const lastAutoSyncStatusRef = React.useRef<string | null>(null);

  const { data: status, isLoading: statusLoading } = useQuery<WhatsAppStatus>({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 3000
  });

  const { data: qr } = useQuery<WhatsAppQrState>({
    queryKey: ['whatsapp-qr'],
    queryFn: () => api.get('/api/whatsapp/qr'),
    refetchInterval: 3000,
    enabled: status?.status !== 'connected' && status?.status !== 'paused'
  });

  React.useEffect(() => {
    setQrTickMs(Date.now());
  }, []);

  React.useEffect(() => {
    if (!qr?.qr) return undefined;
    const timer = window.setInterval(() => {
      setQrTickMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [qr?.qr]);

  const { data: existingTargetsRaw } = useQuery<unknown>({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets'),
    refetchInterval: status?.status === 'connected' ? 10000 : 30000
  });

  const { data: statusAudience } = useQuery<WhatsAppStatusAudience>({
    queryKey: ['whatsapp-status-audience'],
    queryFn: () => api.get('/api/whatsapp/status-audience'),
    refetchInterval: status?.status === 'connected' ? 30000 : 60000
  });
  const { data: settings } = useQuery<BackendSettings>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings')
  });

  const existingTargets = React.useMemo<Target[]>(() => {
    if (!Array.isArray(existingTargetsRaw)) return [];
    return dedupeTargets(existingTargetsRaw as Array<Partial<Target>>, { activeOnly: false });
  }, [existingTargetsRaw]);

  const disconnect = useMutation({
    mutationFn: () => api.post('/api/whatsapp/disconnect'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['targets'] });
    }
  });

  const pauseSession = useMutation({
    mutationFn: () => api.post('/api/whatsapp/pause'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['targets'] });
    }
  });

  const resumeSession = useMutation({
    mutationFn: () => api.post('/api/whatsapp/resume'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['targets'] });
    }
  });

  const refreshQr = useMutation({
    mutationFn: () => api.post('/api/whatsapp/hard-refresh'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['targets'] });
    }
  });

  const syncTargets = useMutation({
    mutationFn: () => api.post('/api/targets/sync', { includeStatus: true, strict: false }),
    onSuccess: () => {
      lastAutoSyncStatusRef.current = status?.status || 'connected';
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status-audience'] });
    },
    onError: () => {
      lastAutoSyncStatusRef.current = null;
    }
  });

  const sendTestMessage = useMutation({
    mutationFn: (payload: SendTestPayload) => api.post<SendTestResponse>('/api/whatsapp/send-test', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-outbox'] });
      queryClient.invalidateQueries({ queryKey: ['logs'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    }
  });

  const isConnected = status?.status === 'connected';
  const isPaused = status?.status === 'paused';
  const isQrReady = status?.status === 'qr' || status?.status === 'qr_ready';
  const qrExpiresAtMs = qr?.expiresAt ? Date.parse(qr.expiresAt) : Number.NaN;
  const qrRemainingMs =
    Number.isFinite(qrExpiresAtMs) && qrTickMs !== null
      ? Math.max(qrExpiresAtMs - qrTickMs, 0)
      : qr?.remainingMs ?? null;
  const qrRemainingMsValue = qrRemainingMs ?? 0;
  const isQrExpired = Boolean(qr?.qr) && ((Number.isFinite(qrExpiresAtMs) && qrRemainingMsValue <= 0) || (!Number.isFinite(qrExpiresAtMs) && Number(qr?.remainingMs || 0) <= 0));
  const activeQr = isQrExpired ? null : qr?.qr || null;
  const qrCountdownLabel = formatQrCountdown(isQrExpired ? 0 : qrRemainingMsValue);
  const activeTargets = React.useMemo(() => {
    return existingTargets.filter((target) => target.active);
  }, [existingTargets]);
  const statusTargets = React.useMemo(() => activeTargets.filter((target) => target.type === 'status'), [activeTargets]);
  const groupedTargets = React.useMemo(() => {
    const groups = activeTargets.filter((target) => target.type === 'group');
    const channels = activeTargets.filter((target) => target.type === 'channel');
    const individuals = activeTargets.filter((target) => target.type === 'individual');
    const statuses = activeTargets.filter((target) => target.type === 'status');
    return { groups, channels, individuals, statuses };
  }, [activeTargets]);
  const destinationSummary = React.useMemo(
    () => ({
      groups: groupedTargets.groups.length,
      channels: groupedTargets.channels.length,
      individuals: groupedTargets.individuals.length,
      status: statusTargets.length
    }),
    [groupedTargets, statusTargets]
  );
  const statusAudienceCount = Number(statusAudience?.participantCount || 0);
  const statusSources = statusAudience?.sources || {
    contactsCache: 0,
    storeContacts: 0,
    storeChats: 0,
    groupMetadata: 0,
    env: 0,
    me: 0,
    activeIndividualTargets: 0,
    recentSuccessfulDirectRecipients: 0
  };
  const statusTrustedAudienceCount =
    Number(statusSources.contactsCache || 0) +
    Number(statusSources.storeContacts || 0) +
    Number(statusSources.storeChats || 0) +
    Number(statusSources.env || 0) +
    Number(statusSources.activeIndividualTargets || 0) +
    Number(statusSources.recentSuccessfulDirectRecipients || 0);
  const statusHasOnlySelfAudience =
    statusAudienceCount <= 1 &&
    statusTrustedAudienceCount <= 0 &&
    Number(statusSources.contactsCache || 0) === 0 &&
    Number(statusSources.storeContacts || 0) === 0 &&
    Number(statusSources.storeChats || 0) === 0 &&
    Number(statusSources.env || 0) === 0 &&
    Number(statusSources.activeIndividualTargets || 0) === 0 &&
    Number(statusSources.recentSuccessfulDirectRecipients || 0) === 0;
  const statusAudienceLabel = statusHasOnlySelfAudience
    ? 'needs private viewers'
    : statusAudienceCount > 0
      ? `${statusAudienceCount} possible viewers from the current snapshot`
      : 'not ready yet';
  const plainSessionState = React.useMemo(() => {
    if (isConnected) return 'Connected and ready for normal queue work.';
    if (isPaused) return 'Paused. Automation and WhatsApp sends are intentionally stopped.';
    if (isQrReady || activeQr) return 'Waiting for you to scan the login code.';
    if (status?.status === 'connecting') return 'Connecting to WhatsApp.';
    if (status?.status === 'conflict') return 'Another instance still has the WhatsApp session.';
    return 'Disconnected. Resume or request a fresh login code.';
  }, [activeQr, isConnected, isPaused, isQrReady, status?.status]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (lastAutoSyncStatusRef.current === status?.status) return;
    syncTargets.mutate();
  }, [isConnected, status?.status]);
  const targetBuckets = React.useMemo(
    () => ({
      all: activeTargets.map((target) => target.phone_number),
      group: groupedTargets.groups.map((target) => target.phone_number),
      channel: groupedTargets.channels.map((target) => target.phone_number),
      individual: groupedTargets.individuals.map((target) => target.phone_number),
      status: groupedTargets.statuses.map((target) => target.phone_number)
    }),
    [activeTargets, groupedTargets]
  );

  React.useEffect(() => {
    setSelectedTargets((current) => {
      if (!current.length) return current;
      const allowed = new Set(activeTargets.map((target) => target.phone_number));
      return current.filter((jid) => allowed.has(jid));
    });
  }, [activeTargets]);

  const getStatusBadge = () => {
    if (statusLoading) return <Badge variant="secondary">Loading...</Badge>;
    if (isPaused) return <Badge variant="secondary">Paused</Badge>;
    if (isConnected) return <Badge variant="success">Connected</Badge>;
    if (isQrReady) return <Badge variant="warning">Scan QR Code</Badge>;
    if (status?.status === 'connecting') return <Badge variant="secondary">Connecting...</Badge>;
    return <Badge variant="destructive">{status?.status || 'Disconnected'}</Badge>;
  };

  const onPickAttachmentFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    if (!file) {
      setAttachmentDataUrl('');
      setAttachmentMimeType('');
      setAttachmentName('');
      return;
    }

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/');
    const isDocument = !isImage && !isVideo && !isAudio;
    if (!isImage && !isVideo && !isAudio && !isDocument) {
      alert('Please choose an image, video, audio, or document file.');
      event.target.value = '';
      return;
    }

    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
    const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
    const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
    const maxBytes = isVideo
      ? MAX_VIDEO_BYTES
      : isAudio
        ? MAX_AUDIO_BYTES
        : isDocument
          ? MAX_DOCUMENT_BYTES
          : MAX_IMAGE_BYTES;
    if (file.size > maxBytes) {
      const maxLabel = isVideo ? '24MB' : isAudio ? '20MB' : isDocument ? '25MB' : '8MB';
      alert(`File too large. Max allowed is ${maxLabel}.`);
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    }).catch(() => '');

    if (!dataUrl) {
      alert('Could not read file.');
      event.target.value = '';
      return;
    }

    setAttachmentDataUrl(dataUrl);
    setAttachmentMimeType(file.type);
    setAttachmentName(file.name);
  };

  const needsAttachment = attachMedia;
  const hasAttachment = Boolean(attachmentDataUrl);
  const hasAnyText = Boolean(testMessage.trim());

  const canSendTest = Boolean(
    selectedTargets.length > 0 &&
    (needsAttachment ? hasAttachment : hasAnyText)
  );

  const messagePlaceholder =
    attachMedia
      ? includeTextWithMedia
        ? 'Write text to send with your attachment'
        : 'Optional text'
      : disableLinkPreview
        ? 'Write plain text message'
        : 'Write your message (include a link for preview)';

  const submitTestMessage = () => {
    if (!canSendTest) return;
    const selectedIncludesStatus = selectedTargets.some((target) => target === 'status@broadcast');
    const statusTestAudience = String(settings?.status_test_audience_jids || '')
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    const payload: SendTestPayload = {
      jids: selectedTargets,
      includeCaption: attachMedia ? includeTextWithMedia : true,
      disableLinkPreview: attachMedia ? false : disableLinkPreview,
      confirm: true
    };
    if (selectedIncludesStatus && statusTestAudience.length) {
      payload.statusJidList = statusTestAudience;
    }

    const normalizedMessage = testMessage.trim();
    if (normalizedMessage && (!attachMedia || includeTextWithMedia)) {
      payload.message = normalizedMessage;
    }

    if (attachmentDataUrl && needsAttachment) {
      if (attachmentMimeType.startsWith('video/')) {
        payload.videoDataUrl = attachmentDataUrl;
      } else if (attachmentMimeType.startsWith('audio/')) {
        payload.audioDataUrl = attachmentDataUrl;
      } else if (attachmentMimeType && !attachmentMimeType.startsWith('image/')) {
        payload.documentDataUrl = attachmentDataUrl;
        payload.documentFilename = attachmentName || 'attachment';
        if (attachmentMimeType) {
          payload.documentMime = attachmentMimeType;
        }
      } else {
        payload.imageDataUrl = attachmentDataUrl;
      }
    }

    sendTestMessage.mutate(payload);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">WhatsApp</h1>
          <p className="text-muted-foreground">Connect once, then send normal messages to your saved destinations.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isPaused ? (
            <Button onClick={() => resumeSession.mutate()} disabled={resumeSession.isPending}>
              <Power className="mr-2 h-4 w-4" />
              {resumeSession.isPending ? 'Resuming...' : 'Resume'}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => pauseSession.mutate()} disabled={pauseSession.isPending}>
              <Power className="mr-2 h-4 w-4" />
              {pauseSession.isPending ? 'Pausing...' : 'Pause'}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => setShowAdvancedRecovery((current) => !current)}>
            {showAdvancedRecovery ? 'Hide recovery tools' : 'Advanced recovery'}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>WhatsApp Session</CardTitle>
              {getStatusBadge()}
            </div>
            <CardDescription>{plainSessionState}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Account</span>
                <span className="font-medium">{status?.me?.name || (isConnected ? 'Connected account' : 'Not connected')}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Synced destinations</span>
                <span className="font-medium">{activeTargets.length}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Target sync</span>
                <span className="font-medium">{syncTargets.isPending ? 'Checking now' : isConnected ? 'Automatic' : 'Waiting for connection'}</span>
              </div>
            </div>

            {status?.lastError ? (
              <div
                className={
                  isPaused
                    ? 'rounded-lg bg-muted p-3 text-sm text-muted-foreground'
                    : 'rounded-lg bg-destructive/10 p-3 text-sm text-destructive'
                }
              >
                <strong>{isPaused ? 'Paused:' : 'Error:'}</strong> {status.lastError}
              </div>
            ) : null}

            {isPaused ? (
              <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                WhatsApp is paused. Resume to reconnect (and to generate a QR code if needed).
              </div>
            ) : !isConnected && !isQrReady ? (
              <div className="space-y-3 rounded-lg bg-warning/10 p-3 text-sm text-warning-foreground">
                <p>Request a fresh login QR, then scan it from WhatsApp Linked Devices.</p>
                <Button onClick={() => refreshQr.mutate()} disabled={refreshQr.isPending} variant="outline" size="sm">
                  <RefreshCw className={`mr-2 h-4 w-4 ${refreshQr.isPending ? 'animate-spin' : ''}`} />
                  {refreshQr.isPending ? 'Refreshing QR...' : 'Get QR code'}
                </Button>
              </div>
            ) : null}

            {showAdvancedRecovery ? (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recovery tools</p>
                <div className="flex flex-wrap gap-2">
                  {!isConnected && !isPaused ? (
                    <Button onClick={() => refreshQr.mutate()} disabled={refreshQr.isPending} variant="outline">
                      <RefreshCw className={`mr-2 h-4 w-4 ${refreshQr.isPending ? 'animate-spin' : ''}`} />
                      {refreshQr.isPending ? 'Refreshing QR...' : 'Get QR code'}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending || !isConnected}
                  >
                    {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Use these only if pause/resume does not recover the session.
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5" />
              QR Code
            </CardTitle>
            <CardDescription>Scan in WhatsApp &rarr; Linked Devices</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-[280px] items-center justify-center">
            {isPaused ? (
              <div className="space-y-3 text-center">
                <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <Power className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">Paused. Resume to reconnect.</p>
              </div>
            ) : isConnected ? (
              <div className="space-y-3 text-center">
                <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
                  <CheckCircle className="h-8 w-8 text-success" />
                </div>
                <p className="text-sm text-muted-foreground">Session is active</p>
              </div>
            ) : activeQr && isSafeImageSrc(activeQr) ? (
              <div className="space-y-3 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={activeQr} alt="WhatsApp QR Code" className="h-56 w-56 rounded-lg border bg-white p-2 object-contain" />
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Scan with your phone</p>
                  <p className="text-xs text-muted-foreground">{qrCountdownLabel}</p>
                </div>
              </div>
            ) : qr?.qr && isQrExpired ? (
              <div className="space-y-3 text-center">
                <p className="text-sm text-muted-foreground">QR expired. Waiting for the next fresh code...</p>
              </div>
            ) : qr?.qr ? (
              <div className="space-y-3 text-center">
                <p className="text-sm text-muted-foreground break-all">
                  QR payload received but could not render as image. Click Get QR code again.
                </p>
              </div>
            ) : (
              <div className="space-y-3 text-center">
                <div className="inline-flex h-16 w-16 animate-pulse items-center justify-center rounded-full bg-muted">
                  <QrCode className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">Waiting for QR code...</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RadioTower className="h-5 w-5" />
            Publishing Destinations
          </CardTitle>
          <CardDescription>
            Groups, channels, and Status are synced from the connected WhatsApp account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg border p-3">
              <p className="text-sm text-muted-foreground">Groups</p>
              <p className="text-2xl font-semibold">{destinationSummary.groups}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-sm text-muted-foreground">Channels</p>
              <p className="text-2xl font-semibold">{destinationSummary.channels}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-sm text-muted-foreground">Private</p>
              <p className="text-2xl font-semibold">{destinationSummary.individuals}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-sm text-muted-foreground">Status</p>
              <p className="text-2xl font-semibold">{destinationSummary.status}</p>
            </div>
          </div>

          <div className={`rounded-lg border p-3 text-sm ${statusHasOnlySelfAudience ? 'border-warning/40 bg-warning/10 text-warning-foreground' : 'bg-muted/30 text-muted-foreground'}`}>
            Status audience: {statusAudienceLabel}
            {statusAudience?.refreshedAt ? `, refreshed ${new Date(statusAudience.refreshedAt).toLocaleString()}` : ''}.
            {Array.isArray(statusAudience?.warnings) && statusAudience.warnings.length ? ` ${statusAudience.warnings[0]}` : ''}
            {statusHasOnlySelfAudience ? ' Add or sync a private WhatsApp contact before using Status, so the app does not create false sent rows.' : ''}
            {statusAudience?.stale ? ' This snapshot is stale because WhatsApp is not connected.' : ''}
          </div>

          {syncTargets.isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Sync could not finish: {(syncTargets.error as Error)?.message || 'Unknown error'}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => syncTargets.mutate()}
              disabled={!isConnected || syncTargets.isPending}
            >
              {syncTargets.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Check destinations now
            </Button>
            <Button asChild variant="outline">
              <Link href="/targets">Review destinations</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {isConnected ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Send Message
            </CardTitle>
            <CardDescription>Select one or many destinations, then send text or media.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Targets</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSelectedTargets(targetBuckets.all)}
                    disabled={!activeTargets.length}
                  >
                    Select all
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSelectedTargets([])}
                    disabled={!selectedTargets.length}
                  >
                    Clear
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedTargets(targetBuckets.group)}
                  disabled={!targetBuckets.group.length}
                >
                  Groups ({targetBuckets.group.length})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedTargets(targetBuckets.channel)}
                  disabled={!targetBuckets.channel.length}
                >
                  Channels ({targetBuckets.channel.length})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedTargets(targetBuckets.individual)}
                  disabled={!targetBuckets.individual.length}
                >
                  Individuals ({targetBuckets.individual.length})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedTargets(targetBuckets.status)}
                  disabled={!targetBuckets.status.length || statusHasOnlySelfAudience}
                >
                  Status ({targetBuckets.status.length})
                </Button>
              </div>
              <div className="max-h-60 space-y-3 overflow-y-auto rounded-lg border p-3">
                {!activeTargets.length ? (
                  <p className="text-sm text-muted-foreground">No active targets available.</p>
                ) : (
                  <>
                    {[
                      { label: 'Channels', items: groupedTargets.channels },
                      { label: 'Groups', items: groupedTargets.groups },
                      { label: 'Individuals', items: groupedTargets.individuals },
                      { label: 'Status', items: groupedTargets.statuses }
                    ].map((group) =>
                      group.items.length ? (
                        <div key={group.label} className="space-y-1">
                          <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
                          {group.items.map((target) => {
                            const checked = selectedTargets.includes(target.phone_number);
                            return (
                              <label key={target.id} className="flex cursor-pointer items-center gap-2 text-sm">
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(next) => {
                                    setSelectedTargets((current) => {
                                      if (next === true) {
                                        return current.includes(target.phone_number)
                                          ? current
                                          : [...current, target.phone_number];
                                      }
                                      return current.filter((value) => value !== target.phone_number);
                                    });
                                  }}
                                />
                                <span className="min-w-0 flex-1 truncate">{formatTargetLabel(target)}</span>
                                <span className="ml-auto text-xs text-muted-foreground">{target.type}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : null
                    )}
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Selected: {selectedTargets.length}
              </p>
            </div>

            <div className="space-y-2">
              <Label>Send style</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button type="button" variant={!attachMedia ? 'default' : 'outline'} onClick={() => setAttachMedia(false)}>
                  Text / link message
                </Button>
                <Button type="button" variant={attachMedia ? 'default' : 'outline'} onClick={() => setAttachMedia(true)}>
                  Attach media/file
                </Button>
              </div>
              {!attachMedia ? (
                <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                  <span>Disable link preview</span>
                  <Switch checked={disableLinkPreview} onCheckedChange={(checked) => setDisableLinkPreview(checked === true)} />
                </label>
              ) : (
                <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                  <span>Include message text under media</span>
                  <Switch
                    checked={includeTextWithMedia}
                    onCheckedChange={(checked) => setIncludeTextWithMedia(checked === true)}
                  />
                </label>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="testMessage">
                {attachMedia && !includeTextWithMedia ? 'Message (optional)' : 'Message'}
              </Label>
              <Textarea
                id="testMessage"
                value={testMessage}
                onChange={(event) => setTestMessage(event.target.value)}
                rows={4}
                placeholder={messagePlaceholder}
              />
            </div>

            {needsAttachment ? (
              <div className="space-y-2">
                <Label htmlFor="attachmentUpload">Attachment</Label>
                <Input
                  id="attachmentUpload"
                  type="file"
                  accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.rtf,.zip"
                  onChange={onPickAttachmentFile}
                />
                {attachmentName ? <p className="text-xs text-muted-foreground">Selected: {attachmentName}</p> : null}
              </div>
            ) : null}

            <div className="flex items-center gap-4">
              <Button onClick={submitTestMessage} disabled={sendTestMessage.isPending || !canSendTest}>
                {sendTestMessage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send
              </Button>
              {sendTestMessage.isSuccess ? (
                (() => {
                  const sent = Number(sendTestMessage.data?.sent || 0);
                  const confirmed = Number(sendTestMessage.data?.confirmed || 0);
                  const uncertain = Number(sendTestMessage.data?.uncertain || 0);
                  const failed = Number(sendTestMessage.data?.failed || 0);
                  const className = failed > 0 && sent === 0 ? 'text-sm text-destructive' : confirmed > 0 ? 'text-sm text-success' : 'text-sm text-warning-foreground';
                  const primary = confirmed > 0
                    ? `Sent to WhatsApp, confirmed ${confirmed}`
                    : sent > 0
                      ? `Submitted to WhatsApp ${sent}`
                      : 'No WhatsApp send was accepted';
                  return (
                    <span className={className}>
                      {primary}
                      {uncertain > 0 ? `, awaiting confirmation ${uncertain}` : ''}
                      {failed > 0 ? `, failed ${failed}` : ''}.
                    </span>
                  );
                })()
              ) : null}
              {sendTestMessage.isError ? (
                <span className="text-sm text-destructive">Failed: {(sendTestMessage.error as Error)?.message || 'Unknown error'}</span>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

    </div>
  );
};

export default WhatsAppPage;
