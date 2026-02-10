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
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';

type SendTestPayload = {
  jid?: string;
  jids?: string[];
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
  sent?: number;
  failed?: number;
  results?: Array<{ jid: string; ok: boolean; messageId?: string | null; error?: string }>;
  confirmation?: {
    ok: boolean;
    via?: string;
    status?: number | null;
    statusLabel?: string | null;
  } | null;
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

  const { data: groupsRaw } = useQuery<unknown>({
    queryKey: ['whatsapp-groups'],
    queryFn: () => api.get('/api/whatsapp/groups'),
    enabled: status?.status === 'connected'
  });

  const { data: channelsRaw } = useQuery<unknown>({
    queryKey: ['whatsapp-channels'],
    queryFn: () => api.get('/api/whatsapp/channels'),
    enabled: status?.status === 'connected'
  });

  const { data: existingTargetsRaw } = useQuery<unknown>({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const groups = React.useMemo<WhatsAppGroup[]>(
    () =>
      Array.isArray(groupsRaw)
        ? (groupsRaw.filter((entry): entry is WhatsAppGroup => Boolean(entry && typeof entry === 'object')) as WhatsAppGroup[])
        : [],
    [groupsRaw]
  );

  const channels = React.useMemo<WhatsAppChannel[]>(
    () =>
      Array.isArray(channelsRaw)
        ? (channelsRaw.filter((entry): entry is WhatsAppChannel => Boolean(entry && typeof entry === 'object')) as WhatsAppChannel[])
        : [],
    [channelsRaw]
  );

  const existingTargets = React.useMemo<Target[]>(
    () =>
      Array.isArray(existingTargetsRaw)
        ? (existingTargetsRaw.filter((entry): entry is Target => Boolean(entry && typeof entry === 'object')) as Target[])
        : [],
    [existingTargetsRaw]
  );

  const disconnect = useMutation({
    mutationFn: () => api.post('/api/whatsapp/disconnect'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels'] });
    }
  });

  const refreshQr = useMutation({
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
  const activeTargets = React.useMemo(() => {
    const isPlaceholderChannel = (target: Target) =>
      target.type === 'channel' &&
      (/^channel\s+\d+$/i.test(String(target.name || '').trim()) ||
        String(target.name || '').toLowerCase().includes('@newsletter'));
    return existingTargets.filter((target) => target.active && !isPlaceholderChannel(target));
  }, [existingTargets]);
  const groupedTargets = React.useMemo(() => {
    const groups = activeTargets.filter((target) => target.type === 'group');
    const channels = activeTargets.filter((target) => target.type === 'channel');
    const statusTargets = activeTargets.filter((target) => target.type === 'status');
    const individuals = activeTargets.filter((target) => target.type === 'individual');
    return { groups, channels, statusTargets, individuals };
  }, [activeTargets]);
  const targetBuckets = React.useMemo(
    () => ({
      all: activeTargets.map((target) => target.phone_number),
      group: groupedTargets.groups.map((target) => target.phone_number),
      channel: groupedTargets.channels.map((target) => target.phone_number),
      status: groupedTargets.statusTargets.map((target) => target.phone_number),
      individual: groupedTargets.individuals.map((target) => target.phone_number)
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

    const payload: SendTestPayload = {
      jids: selectedTargets,
      includeCaption: attachMedia ? includeTextWithMedia : true,
      disableLinkPreview: attachMedia ? false : disableLinkPreview
    };

    const normalizedMessage = testMessage.trim();
    if (normalizedMessage && (!attachMedia || includeTextWithMedia)) {
      payload.message = normalizedMessage;
    }

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
          <h1 className="text-3xl font-bold tracking-tight">WhatsApp</h1>
          <p className="text-muted-foreground">Connect once, then send normal messages to your saved destinations.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => disconnect.mutate()} disabled={disconnect.isPending || !isConnected}>
            <Power className="mr-2 h-4 w-4" />
            {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
          </Button>
          {!isConnected ? (
            <Button onClick={() => refreshQr.mutate()} disabled={refreshQr.isPending}>
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshQr.isPending ? 'animate-spin' : ''}`} />
              {refreshQr.isPending ? 'Refreshing QR...' : 'Get QR code'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>WhatsApp Session</CardTitle>
              {getStatusBadge()}
            </div>
            <CardDescription>Current account session</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Account</span>
                <span className="font-medium">{status?.me?.name || (isConnected ? 'Connected account' : 'Not connected')}</span>
              </div>
            </div>

            {status?.lastError ? (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <strong>Error:</strong> {status.lastError}
              </div>
            ) : null}

            {!isConnected && !isQrReady ? (
              <div className="rounded-lg bg-warning/10 p-3 text-sm text-warning-foreground">
                Tap <strong>Get QR code</strong> to request a fresh login QR.
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
                <p className="text-sm text-muted-foreground">Session is active</p>
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
                  onClick={() => setSelectedTargets(targetBuckets.status)}
                  disabled={!targetBuckets.status.length}
                >
                  Status ({targetBuckets.status.length})
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
              </div>
              <div className="max-h-60 space-y-3 overflow-y-auto rounded-lg border p-3">
                {!activeTargets.length ? (
                  <p className="text-sm text-muted-foreground">No active targets available.</p>
                ) : (
                  <>
                    {[
                      { label: 'Channels', items: groupedTargets.channels },
                      { label: 'Groups', items: groupedTargets.groups },
                      { label: 'Status', items: groupedTargets.statusTargets },
                      { label: 'Individuals', items: groupedTargets.individuals }
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
                                <span>{target.name}</span>
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
                  Attach image/video
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
                  Sent {sendTestMessage.data?.sent ?? 1}
                  {(sendTestMessage.data?.failed ?? 0) > 0 ? `, failed ${sendTestMessage.data?.failed}` : ''}.
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
