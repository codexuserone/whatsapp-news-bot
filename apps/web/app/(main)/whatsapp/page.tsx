'use client';

import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Target, WhatsAppChannel, WhatsAppGroup, WhatsAppOutbox, WhatsAppOutboxStatus, WhatsAppStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Power, CheckCircle, QrCode, Users, Loader2, Send, MessageSquare, Wrench, Radio, CheckCheck } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

type SendTestPayload = {
  jid: string;
  message?: string;
  linkUrl?: string;
  imageUrl?: string;
  imageDataUrl?: string;
  includeCaption?: boolean;
};

type SendTestResponse = {
  ok: boolean;
  messageId?: string | null;
  confirmation?: {
    ok: boolean;
    via?: string;
    status?: number | null;
    statusLabel?: string | null;
  } | null;
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

const WhatsAppPage = () => {
  const queryClient = useQueryClient();
  const [testTarget, setTestTarget] = React.useState('');
  const [testMessage, setTestMessage] = React.useState('');
  const [testLinkUrl, setTestLinkUrl] = React.useState('');
  const [attachmentMode, setAttachmentMode] = React.useState<'none' | 'url' | 'upload'>('none');
  const [testImageUrl, setTestImageUrl] = React.useState('');
  const [imageDataUrl, setImageDataUrl] = React.useState('');
  const [imageName, setImageName] = React.useState('');
  const [includeCaption, setIncludeCaption] = React.useState(true);

  const { data: status, isLoading: statusLoading } = useQuery<WhatsAppStatus>({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 3000
  });

  const { data: qr } = useQuery<{ qr: string | null }>({
    queryKey: ['whatsapp-qr'],
    queryFn: () => api.get('/api/whatsapp/qr'),
    refetchInterval: 3000,
    enabled: status?.status !== 'connected'
  });

  const { data: groups = [], isLoading: groupsLoading } = useQuery<WhatsAppGroup[]>({
    queryKey: ['whatsapp-groups'],
    queryFn: () => api.get('/api/whatsapp/groups'),
    enabled: status?.status === 'connected'
  });

  const { data: channels = [], isLoading: channelsLoading } = useQuery<WhatsAppChannel[]>({
    queryKey: ['whatsapp-channels'],
    queryFn: () => api.get('/api/whatsapp/channels'),
    enabled: status?.status === 'connected'
  });

  const { data: existingTargets = [] } = useQuery<Target[]>({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const { data: outbox } = useQuery<WhatsAppOutbox>({
    queryKey: ['whatsapp-outbox'],
    queryFn: () => api.get('/api/whatsapp/outbox'),
    refetchInterval: 3000,
    enabled: status?.status === 'connected'
  });

  const disconnect = useMutation({
    mutationFn: () => api.post('/api/whatsapp/disconnect'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels'] });
    }
  });

  const reconnect = useMutation({
    mutationFn: () => api.post('/api/whatsapp/hard-refresh'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels'] });
    }
  });

  const clearSenderKeys = useMutation({
    mutationFn: () => api.post('/api/whatsapp/clear-sender-keys'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels'] });
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
  const isQrReady = status?.status === 'qr' || status?.status === 'qr_ready';
  const activeTargets = existingTargets.filter((target) => target.active);
  const statusByMessageId = React.useMemo(() => {
    const map = new Map<string, WhatsAppOutboxStatus>();
    for (const snap of outbox?.statuses || []) {
      if (!snap?.id) continue;
      map.set(String(snap.id), snap);
    }
    return map;
  }, [outbox?.statuses]);

  const recentOutboxMessages = React.useMemo(() => {
    const list = [...(outbox?.messages || [])];
    const getTs = (value?: number | string | null) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    list.sort((a, b) => getTs(b.timestamp) - getTs(a.timestamp));
    return list.slice(0, 12);
  }, [outbox?.messages]);

  const getOutboxReceiptBadge = (messageId: string) => {
    const snap = statusByMessageId.get(String(messageId));
    if (!snap) {
      return <Badge variant="warning">Not observed</Badge>;
    }

    const label = mapMessageStatusLabel(snap.status, snap.statusLabel);
    if (!label) return <Badge variant="secondary">Observed</Badge>;
    const lower = label.toLowerCase();
    if (lower === 'error') return <Badge variant="destructive">{label}</Badge>;
    if (lower === 'delivered' || lower === 'read' || lower === 'played') return <Badge variant="success">{label}</Badge>;
    if (lower === 'pending' || lower === 'server') return <Badge variant="warning">{label}</Badge>;
    return <Badge variant="secondary">{label}</Badge>;
  };

  const getStatusBadge = () => {
    if (statusLoading) return <Badge variant="secondary">Loading...</Badge>;
    if (isConnected) return <Badge variant="success">Connected</Badge>;
    if (isQrReady) return <Badge variant="warning">Scan QR Code</Badge>;
    if (status?.status === 'connecting') return <Badge variant="secondary">Connecting...</Badge>;
    return <Badge variant="destructive">{status?.status || 'Disconnected'}</Badge>;
  };

  const onPickImageFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    if (!file) {
      setImageDataUrl('');
      setImageName('');
      return;
    }

    if (!file.type.startsWith('image/')) {
      alert('Please choose an image file.');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read image file'));
      reader.readAsDataURL(file);
    }).catch(() => '');

    if (!dataUrl) {
      alert('Could not read image file.');
      event.target.value = '';
      return;
    }

    setImageDataUrl(dataUrl);
    setImageName(file.name);
  };

  const canSendTest = Boolean(
    testTarget &&
      (testMessage.trim() ||
        testLinkUrl.trim() ||
        (attachmentMode === 'url' && testImageUrl.trim()) ||
        (attachmentMode === 'upload' && imageDataUrl))
  );

  const submitTestMessage = () => {
    if (!canSendTest) return;

    const payload: SendTestPayload = { jid: testTarget, includeCaption };
    const normalizedMessage = testMessage.trim();
    const normalizedLink = testLinkUrl.trim();
    if (normalizedMessage) payload.message = normalizedMessage;
    if (normalizedLink) payload.linkUrl = normalizedLink;

    if (attachmentMode === 'url' && testImageUrl.trim()) {
      payload.imageUrl = testImageUrl.trim();
    }
    if (attachmentMode === 'upload' && imageDataUrl) {
      payload.imageDataUrl = imageDataUrl;
    }

    sendTestMessage.mutate(payload);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">WhatsApp Console</h1>
          <p className="text-muted-foreground">Connect once, then targets sync automatically from your WhatsApp account.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => disconnect.mutate()} disabled={disconnect.isPending || !isConnected}>
            <Power className="mr-2 h-4 w-4" />
            {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
          </Button>
          <Button onClick={() => reconnect.mutate()} disabled={reconnect.isPending}>
            <RefreshCw className={`mr-2 h-4 w-4 ${reconnect.isPending ? 'animate-spin' : ''}`} />
            {reconnect.isPending ? 'Reconnecting...' : 'Reconnect'}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Connection Status</CardTitle>
              {getStatusBadge()}
            </div>
            <CardDescription>Current account and connection health</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <span className="font-medium">{status?.status || 'Unknown'}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Connected account</span>
                <span className="font-medium">{status?.me?.name || status?.me?.jid || 'Unknown'}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last Connected</span>
                <span className="font-medium">{status?.lastSeenAt ? new Date(status.lastSeenAt).toLocaleString() : 'Never'}</span>
              </div>
            </div>

            {status?.lastError ? (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <strong>Error:</strong> {status.lastError}
              </div>
            ) : null}

            {!isConnected && !isQrReady ? (
              <div className="rounded-lg bg-warning/10 p-3 text-sm text-warning-foreground">
                Click <strong>Reconnect</strong> to request a fresh QR code.
              </div>
            ) : null}

            {isConnected ? (
              <div className="rounded-lg bg-success/10 p-3 text-sm text-success">
                Connected. Open <Link href="/targets" className="underline">Targets</Link> to sync and review destinations.
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
            {isConnected ? (
              <div className="space-y-3 text-center">
                <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
                  <CheckCircle className="h-8 w-8 text-success" />
                </div>
                <p className="text-sm text-muted-foreground">WhatsApp is connected</p>
              </div>
            ) : qr?.qr ? (
              <div className="space-y-3 text-center">
                <Image
                  src={qr.qr}
                  alt="WhatsApp QR Code"
                  width={224}
                  height={224}
                  unoptimized
                  className="h-56 w-56 rounded-lg border bg-white p-2"
                />
                <p className="text-sm text-muted-foreground">Scan with your phone</p>
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

      {isConnected ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Send Test Message
            </CardTitle>
            <CardDescription>Use normal message fields; no JIDs required.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="testTarget">Target</Label>
              <Select
                value={testTarget ? testTarget : '__none'}
                onValueChange={(value) => setTestTarget(value === '__none' ? '' : value)}
              >
                <SelectTrigger id="testTarget" className={!testTarget ? 'text-muted-foreground' : undefined}>
                  <SelectValue placeholder="Select a target" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none" className="text-muted-foreground">
                    Select a target
                  </SelectItem>
                  {activeTargets.length > 0 ? (
                    activeTargets.map((target) => (
                      <SelectItem key={target.id} value={target.phone_number}>
                        {target.name} ({target.type})
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__no_targets" disabled>
                      No active targets
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="testMessage">Message (optional if sending image)</Label>
              <Textarea
                id="testMessage"
                value={testMessage}
                onChange={(event) => setTestMessage(event.target.value)}
                rows={4}
                placeholder="Write a normal message"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="testLinkUrl">Link (optional)</Label>
              <Input
                id="testLinkUrl"
                value={testLinkUrl}
                onChange={(event) => setTestLinkUrl(event.target.value)}
                placeholder="https://example.com/story"
              />
            </div>

            <div className="space-y-2">
              <Label>Image attachment</Label>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant={attachmentMode === 'none' ? 'default' : 'outline'} onClick={() => setAttachmentMode('none')}>
                  No image
                </Button>
                <Button type="button" variant={attachmentMode === 'upload' ? 'default' : 'outline'} onClick={() => setAttachmentMode('upload')}>
                  Upload file
                </Button>
                <Button type="button" variant={attachmentMode === 'url' ? 'default' : 'outline'} onClick={() => setAttachmentMode('url')}>
                  Use image URL
                </Button>
              </div>
            </div>

            {attachmentMode === 'upload' ? (
              <div className="space-y-2">
                <Label htmlFor="imageUpload">Choose image file</Label>
                <Input id="imageUpload" type="file" accept="image/*" onChange={onPickImageFile} />
                {imageName ? <p className="text-xs text-muted-foreground">Selected: {imageName}</p> : null}
              </div>
            ) : null}

            {attachmentMode === 'url' ? (
              <div className="space-y-2">
                <Label htmlFor="testImageUrl">Image URL</Label>
                <Input
                  id="testImageUrl"
                  value={testImageUrl}
                  onChange={(event) => setTestImageUrl(event.target.value)}
                  placeholder="https://example.com/image.jpg"
                />
              </div>
            ) : null}

            {attachmentMode !== 'none' ? (
              <div className="flex items-center gap-2">
                <Switch id="includeCaption" checked={includeCaption} onCheckedChange={(checked) => setIncludeCaption(checked === true)} />
                <Label htmlFor="includeCaption">Send message/link as image caption</Label>
              </div>
            ) : null}

            <div className="flex items-center gap-4">
              <Button onClick={submitTestMessage} disabled={sendTestMessage.isPending || !canSendTest}>
                {sendTestMessage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send Test
              </Button>
              {sendTestMessage.isSuccess ? (
                <span className="text-sm text-success">
                  Sent {sendTestMessage.data?.messageId ? `(${sendTestMessage.data.messageId})` : ''}
                  {sendTestMessage.data?.confirmation
                    ? ` via ${sendTestMessage.data.confirmation.via || 'unknown'}${mapMessageStatusLabel(sendTestMessage.data.confirmation.status, sendTestMessage.data.confirmation.statusLabel) ? ` (${mapMessageStatusLabel(sendTestMessage.data.confirmation.status, sendTestMessage.data.confirmation.statusLabel)})` : ''}`
                    : ''}
                </span>
              ) : null}
              {sendTestMessage.isError ? (
                <span className="text-sm text-destructive">Failed: {(sendTestMessage.error as Error)?.message || 'Unknown error'}</span>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {isConnected ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radio className="h-5 w-5" />
              Live Delivery Stream
            </CardTitle>
            <CardDescription>Real-time local send/receipt snapshots from this connected client session.</CardDescription>
          </CardHeader>
          <CardContent>
            {recentOutboxMessages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent outgoing messages observed yet.</p>
            ) : (
              <div className="space-y-2">
                {recentOutboxMessages.map((message) => (
                  <div key={message.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
                    <Badge variant="outline" className="max-w-[180px] truncate" title={message.id}>
                      {message.id}
                    </Badge>
                    {getOutboxReceiptBadge(message.id)}
                    {message.hasImage ? <Badge variant="secondary">image</Badge> : null}
                    {message.hasText ? <Badge variant="secondary">text</Badge> : null}
                    {message.hasCaption ? <Badge variant="secondary">caption</Badge> : null}
                    <span className="truncate text-muted-foreground" title={String(message.remoteJid || '')}>
                      {message.remoteJid || 'unknown jid'}
                    </span>
                    <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
                      <CheckCheck className="h-3.5 w-3.5" />
                      {(() => {
                        const raw = typeof message.timestamp === 'number' ? message.timestamp : Number(message.timestamp);
                        if (!Number.isFinite(raw)) return 'now';
                        const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
                        return new Date(ms).toLocaleTimeString();
                      })()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Discoverable destinations
          </CardTitle>
          <CardDescription>These come directly from your connected account and sync into Targets.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">Groups</span>
                <Badge variant="secondary">{groups.length}</Badge>
              </div>
              {!isConnected ? (
                <p className="text-sm text-muted-foreground">Connect WhatsApp to load groups.</p>
              ) : groupsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : groups.length ? (
                <p className="text-sm text-muted-foreground">{groups[0]?.name || 'First group available'} and more</p>
              ) : (
                <p className="text-sm text-muted-foreground">No groups detected.</p>
              )}
            </div>

            <div className="rounded-lg border p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">Channels</span>
                <Badge variant="secondary">{channels.length}</Badge>
              </div>
              {!isConnected ? (
                <p className="text-sm text-muted-foreground">Connect WhatsApp to load channels.</p>
              ) : channelsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : channels.length ? (
                <p className="text-sm text-muted-foreground">{channels[0]?.name || 'First channel available'} and more</p>
              ) : (
                <p className="text-sm text-muted-foreground">No channels detected.</p>
              )}
            </div>
          </div>

          <Button asChild variant="outline">
            <Link href="/targets">Open Targets and Sync</Link>
          </Button>
        </CardContent>
      </Card>

      <details className="rounded-lg border bg-muted/20 p-4">
        <summary className="cursor-pointer list-none font-medium">
          <span className="inline-flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Advanced recovery tools
          </span>
        </summary>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => clearSenderKeys.mutate()} disabled={clearSenderKeys.isPending}>
            {clearSenderKeys.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Clear Sender Keys
          </Button>
          <Button variant="outline" onClick={() => reconnect.mutate()} disabled={reconnect.isPending}>
            Force New QR
          </Button>
        </div>
      </details>
    </div>
  );
};

export default WhatsAppPage;
