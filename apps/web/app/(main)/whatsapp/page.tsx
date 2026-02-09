'use client';

import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Target, WhatsAppChannel, WhatsAppGroup, WhatsAppStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Power, CheckCircle, QrCode, Users, Loader2, Send, MessageSquare } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';

type SendTestPayload = {
  jid: string;
  message?: string;
  linkUrl?: string;
  imageUrl?: string;
  imageDataUrl?: string;
  videoDataUrl?: string;
  includeCaption?: boolean;
  disableLinkPreview?: boolean;
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
  const [composeMode, setComposeMode] = React.useState<'text_preview' | 'text_only' | 'image_caption' | 'image_only'>('text_preview');
  const [attachmentDataUrl, setAttachmentDataUrl] = React.useState('');
  const [attachmentMimeType, setAttachmentMimeType] = React.useState('');
  const [attachmentName, setAttachmentName] = React.useState('');

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
  const getStatusBadge = () => {
    if (statusLoading) return <Badge variant="secondary">Loading...</Badge>;
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
    if (!isImage && !isVideo) {
      alert('Please choose an image or video file.');
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
      alert('Could not read file.');
      event.target.value = '';
      return;
    }

    setAttachmentDataUrl(dataUrl);
    setAttachmentMimeType(file.type);
    setAttachmentName(file.name);
  };

  const needsAttachment = composeMode === 'image_caption' || composeMode === 'image_only';
  const hasAttachment = Boolean(attachmentDataUrl);
  const hasAnyText = Boolean(testMessage.trim());

  const canSendTest = Boolean(testTarget && (needsAttachment ? hasAttachment : hasAnyText));

  const messagePlaceholder =
    composeMode === 'text_preview'
      ? 'Write your message (include a link if you want a preview)'
      : composeMode === 'text_only'
        ? 'Write plain text'
        : composeMode === 'image_only'
          ? 'Optional caption'
          : 'Write caption for your attachment';

  const submitTestMessage = () => {
    if (!canSendTest) return;

    const payload: SendTestPayload = {
      jid: testTarget,
      includeCaption: composeMode !== 'image_only',
      disableLinkPreview: composeMode === 'text_only'
    };

    const normalizedMessage = testMessage.trim();
    if (normalizedMessage) payload.message = normalizedMessage;

    if (attachmentDataUrl && needsAttachment) {
      if (attachmentMimeType.startsWith('video/')) {
        payload.videoDataUrl = attachmentDataUrl;
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
          <h1 className="text-3xl font-bold tracking-tight">WhatsApp Console</h1>
          <p className="text-muted-foreground">Connect once and send normal messages to saved destinations.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => disconnect.mutate()} disabled={disconnect.isPending || !isConnected}>
            <Power className="mr-2 h-4 w-4" />
            {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
          </Button>
          {!isConnected ? (
            <Button onClick={() => reconnect.mutate()} disabled={reconnect.isPending}>
              <RefreshCw className={`mr-2 h-4 w-4 ${reconnect.isPending ? 'animate-spin' : ''}`} />
              {reconnect.isPending ? 'Refreshing...' : 'Refresh QR Code'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Connection Status</CardTitle>
              {getStatusBadge()}
            </div>
            <CardDescription>Current connection health</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Connected account</span>
                <span className="font-medium">{status?.me?.name || status?.me?.jid?.split('@')[0] || 'Not connected'}</span>
              </div>
            </div>

            {status?.lastError ? (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <strong>Error:</strong> {status.lastError}
              </div>
            ) : null}

            {!isConnected && !isQrReady ? (
              <div className="rounded-lg bg-warning/10 p-3 text-sm text-warning-foreground">
                Click <strong>Refresh QR Code</strong> to request a fresh QR code.
              </div>
            ) : null}

            {isConnected ? (
              <div className="rounded-lg bg-success/10 p-3 text-sm text-success">
                Connected. Open <Link href="/targets" className="underline">Targets</Link> to review destinations.
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
              Send Message
            </CardTitle>
            <CardDescription>Choose destination, write text, and optionally attach an image/video file.</CardDescription>
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
              <Label>Message style</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant={composeMode === 'text_preview' ? 'default' : 'outline'}
                  onClick={() => setComposeMode('text_preview')}
                >
                  Text + link preview
                </Button>
                <Button
                  type="button"
                  variant={composeMode === 'text_only' ? 'default' : 'outline'}
                  onClick={() => setComposeMode('text_only')}
                >
                  Text only
                </Button>
                <Button
                  type="button"
                  variant={composeMode === 'image_caption' ? 'default' : 'outline'}
                  onClick={() => setComposeMode('image_caption')}
                >
                  Image/video + caption
                </Button>
                <Button
                  type="button"
                  variant={composeMode === 'image_only' ? 'default' : 'outline'}
                  onClick={() => setComposeMode('image_only')}
                >
                  Image/video only
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="testMessage">
                {composeMode === 'image_only' ? 'Caption (optional)' : 'Message'}
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
                <Input id="attachmentUpload" type="file" accept="image/*,video/*" onChange={onPickAttachmentFile} />
                {attachmentName ? <p className="text-xs text-muted-foreground">Selected: {attachmentName}</p> : null}
              </div>
            ) : null}

            <div className="flex items-center gap-4">
              <Button onClick={submitTestMessage} disabled={sendTestMessage.isPending || !canSendTest}>
                {sendTestMessage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Available destinations
          </CardTitle>
          <CardDescription>Groups and channels loaded from your connected account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">Groups</span>
                <Badge variant="secondary">{groups.length}</Badge>
              </div>
            </div>

            <div className="rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">Channels</span>
                <Badge variant="secondary">{channels.length}</Badge>
              </div>
            </div>
          </div>

          <Button asChild variant="outline" className="w-full">
            <Link href="/targets">Manage Targets</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default WhatsAppPage;
