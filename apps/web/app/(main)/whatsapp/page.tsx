'use client';

import React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Target, WhatsAppQrState, WhatsAppStatus } from '@/lib/types';
import { dedupeTargets } from '@/lib/targetUtils';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, RefreshCw, Power, QrCode, RadioTower, Send } from 'lucide-react';

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

  const existingTargets = React.useMemo<Target[]>(() => {
    if (!Array.isArray(existingTargetsRaw)) return [];
    return dedupeTargets(existingTargetsRaw as Array<Partial<Target>>, { activeOnly: false });
  }, [existingTargetsRaw]);

  const resumeSession = useMutation({
    mutationFn: () => api.post('/api/whatsapp/resume'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['targets'] });
    }
  });

  const refreshQr = useMutation({
    mutationFn: (force?: boolean) => api.post('/api/whatsapp/hard-refresh', { force: Boolean(force) }),
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
    },
    onError: () => {
      lastAutoSyncStatusRef.current = null;
    }
  });

  const isConnected = status?.status === 'connected';
  const isPaused = status?.status === 'paused';
  const isQrReady = status?.status === 'qr' || status?.status === 'qr_ready';
  const requiresManualPairing =
    status?.requiresManualPairing === true ||
    (status?.status === 'error' &&
      /fresh pairing required|automatic recovery could not open|login handshake before a qr|pairing bootstrap failed/i.test(
        String(status?.lastError || '')
      ));
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
  const plainSessionState = React.useMemo(() => {
    if (isConnected) return 'Connected and ready for normal queue work.';
    if (isPaused) return 'WhatsApp connection is paused. Scheduled sends are held.';
    if (isQrReady || activeQr) return 'Waiting for you to scan the login code.';
    if (requiresManualPairing) return 'WhatsApp did not issue a login code. Queued messages are being held, not marked sent.';
    if (status?.status === 'connecting') return 'Connecting to WhatsApp.';
    if (status?.status === 'conflict') return 'Another instance still has the WhatsApp session.';
    return 'Disconnected. Request a fresh login code.';
  }, [activeQr, isConnected, isPaused, isQrReady, requiresManualPairing, status?.status]);

  React.useEffect(() => {
    if (!isConnected) return;
    const syncKey = status?.status || 'connected';
    if (lastAutoSyncStatusRef.current === syncKey) return;
    lastAutoSyncStatusRef.current = syncKey;
    syncTargets.mutate();
  }, [isConnected, status?.status, syncTargets]);

  const getStatusBadge = () => {
    if (statusLoading) return <Badge variant="secondary">Loading...</Badge>;
    if (isPaused) return <Badge variant="secondary">Paused</Badge>;
    if (isConnected) return <Badge variant="success">Connected</Badge>;
    if (isQrReady) return <Badge variant="warning">Scan QR Code</Badge>;
    if (requiresManualPairing) return <Badge variant="destructive">Login blocked</Badge>;
    if (status?.status === 'connecting') return <Badge variant="secondary">Connecting...</Badge>;
    return <Badge variant="destructive">{status?.status || 'Disconnected'}</Badge>;
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
              {resumeSession.isPending ? 'Resuming...' : 'Resume WhatsApp'}
            </Button>
          ) : !isConnected ? (
            <Button type="button" variant="outline" onClick={() => setShowAdvancedRecovery((current) => !current)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {showAdvancedRecovery ? 'Hide repair' : 'Connection repair'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className={isConnected ? 'grid gap-6' : 'grid gap-6 lg:grid-cols-2'}>
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
                <span className="text-muted-foreground">Destinations</span>
                <span className="font-medium">{activeTargets.length}</span>
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
                WhatsApp connection is paused. Resume to reconnect.
              </div>
            ) : requiresManualPairing ? (
              <div className="space-y-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <p>
                  WhatsApp rejected the login before the app received a QR code. Automatic retries are stopped so the phone
                  and desktop sessions are not disturbed.
                </p>
                <Button onClick={() => refreshQr.mutate(true)} disabled={refreshQr.isPending} variant="outline" size="sm">
                  <RefreshCw className={`mr-2 h-4 w-4 ${refreshQr.isPending ? 'animate-spin' : ''}`} />
                  {refreshQr.isPending ? 'Trying login...' : 'Try login again'}
                </Button>
              </div>
            ) : !isConnected && !isQrReady ? (
              <div className="space-y-3 rounded-lg bg-warning/10 p-3 text-sm text-warning-foreground">
                <p>Request a fresh login QR, then scan it from WhatsApp Linked Devices.</p>
                <Button onClick={() => refreshQr.mutate(false)} disabled={refreshQr.isPending} variant="outline" size="sm">
                  <RefreshCw className={`mr-2 h-4 w-4 ${refreshQr.isPending ? 'animate-spin' : ''}`} />
                  {refreshQr.isPending ? 'Refreshing QR...' : 'Get QR code'}
                </Button>
              </div>
            ) : null}

            {showAdvancedRecovery && !isConnected && !isPaused ? (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Connection repair</p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => refreshQr.mutate(requiresManualPairing)} disabled={refreshQr.isPending} variant="outline">
                    <RefreshCw className={`mr-2 h-4 w-4 ${refreshQr.isPending ? 'animate-spin' : ''}`} />
                    {refreshQr.isPending ? 'Trying login...' : requiresManualPairing ? 'Try login again' : 'Get QR code'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Use this only when the app is disconnected or waiting for a fresh linked-device login.
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {!isConnected ? (
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
              ) : requiresManualPairing ? (
                <div className="space-y-3 text-center">
                  <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                    <AlertTriangle className="h-8 w-8 text-destructive" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">No login code available</p>
                    <p className="text-sm text-muted-foreground">Queued messages are held until WhatsApp connects.</p>
                  </div>
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
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RadioTower className="h-5 w-5" />
            Publishing Destinations
          </CardTitle>
          <CardDescription>
            Groups, channels, and Status stay in sync from the connected WhatsApp account.
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

          {syncTargets.isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Destinations could not update: {(syncTargets.error as Error)?.message || 'Unknown error'}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/targets">Review destinations</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            Send Messages
          </CardTitle>
          <CardDescription>
            Use the normal composer for text, image captions, videos, documents, and multi-target sends.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild disabled={!isConnected}>
            <Link href="/compose">Open composer</Link>
          </Button>
          {!isConnected ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Connect WhatsApp before sending or queueing new manual messages.
            </p>
          ) : null}
        </CardContent>
      </Card>

    </div>
  );
};

export default WhatsAppPage;
