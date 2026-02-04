'use client';

import React from 'react';
import Image from 'next/image';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Target, WhatsAppChannel, WhatsAppGroup, WhatsAppStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Power, CheckCircle, QrCode, Users, Radio, Loader2, Send, MessageSquare, KeyRound } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';

const WhatsAppPage = () => {
  const queryClient = useQueryClient();
  const [testTarget, setTestTarget] = React.useState('');
  const [testMessage, setTestMessage] = React.useState('Hello from WhatsApp News Bot!');
  const [testImageUrl, setTestImageUrl] = React.useState('');

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

  const hardRefresh = useMutation({
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

  type TargetPayload = {
    name: string;
    phone_number: string;
    type: Target['type'];
    active: boolean;
    notes?: string | null;
  };

  type SendTestPayload = {
    jid: string;
    message: string;
    imageUrl?: string;
  };

  const addTarget = useMutation({
    mutationFn: (payload: TargetPayload) => api.post('/api/targets', payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['targets'] })
  });

  const sendTestMessage = useMutation({
    mutationFn: (payload: SendTestPayload) => api.post('/api/whatsapp/send-test', payload),
    onSuccess: () => {
      setTestMessage('Hello from WhatsApp News Bot!');
      setTestImageUrl('');
    }
  });

  const isConnected = status?.status === 'connected';
  const isQrReady = status?.status === 'qr' || status?.status === 'qr_ready';
  const existingPhones = new Set(existingTargets.map((t) => t.phone_number));
  const activeTargets = existingTargets.filter((t) => t.active);

  const getStatusBadge = () => {
    if (statusLoading) return <Badge variant="secondary">Loading...</Badge>;
    if (isConnected) return <Badge variant="success">Connected</Badge>;
    if (isQrReady) return <Badge variant="warning">Scan QR Code</Badge>;
    if (status?.status === 'connecting') return <Badge variant="secondary">Connecting...</Badge>;
    return <Badge variant="destructive">{status?.status || 'Disconnected'}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">WhatsApp Console</h1>
          <p className="text-muted-foreground">Connect and manage your WhatsApp integration.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending || !isConnected}
          >
            <Power className="mr-2 h-4 w-4" />
            {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
          </Button>
          <Button
            variant="outline"
            onClick={() => clearSenderKeys.mutate()}
            disabled={clearSenderKeys.isPending}
          >
            <KeyRound className="mr-2 h-4 w-4" />
            {clearSenderKeys.isPending ? 'Clearing...' : 'Clear Sender Keys'}
          </Button>
          <Button onClick={() => hardRefresh.mutate()} disabled={hardRefresh.isPending}>
            <RefreshCw className={`mr-2 h-4 w-4 ${hardRefresh.isPending ? 'animate-spin' : ''}`} />
            {hardRefresh.isPending ? 'Refreshing...' : 'Hard Refresh'}
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
            <CardDescription>WhatsApp Web connection state</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <span className="font-medium">{status?.status || 'Unknown'}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last Connected</span>
                <span className="font-medium">
                  {status?.lastSeenAt ? new Date(status.lastSeenAt).toLocaleString() : 'Never'}
                </span>
              </div>
            </div>

            {status?.lastError && (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <strong>Error:</strong> {status.lastError}
              </div>
            )}

            {!isConnected && !isQrReady && (
              <div className="rounded-lg bg-warning/10 p-3 text-sm text-warning-foreground">
                Click <strong>Hard Refresh</strong> to generate a new QR code.
              </div>
            )}

            {isConnected && (
              <div className="rounded-lg bg-success/10 p-3 text-sm text-success">
                WhatsApp is connected. Import groups and channels below.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5" />
              QR Code
            </CardTitle>
            <CardDescription>Scan to connect your WhatsApp</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-[280px] items-center justify-center">
            {isConnected ? (
                <div className="text-center space-y-3">
                  <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
                  <CheckCircle className="h-8 w-8 text-success" />
                  </div>
                  <p className="text-sm text-muted-foreground">WhatsApp is connected</p>
                </div>
            ) : qr?.qr ? (
              <div className="text-center space-y-3">
                <Image
                  src={qr.qr}
                  alt="WhatsApp QR Code"
                  width={224}
                  height={224}
                  unoptimized
                  className="h-56 w-56 rounded-lg border bg-white p-2"
                />
                <p className="text-sm text-muted-foreground">Scan with WhatsApp on your phone</p>
              </div>
            ) : (
              <div className="text-center space-y-3">
                <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-muted animate-pulse">
                  <QrCode className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">Waiting for QR code...</p>
                <p className="text-xs text-muted-foreground">Click Hard Refresh if nothing appears</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {isConnected && existingTargets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Send Test Message
            </CardTitle>
            <CardDescription>Send a test message to verify your setup</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="testTarget">Target</Label>
                <Select
                  value={testTarget ? testTarget : '__none'}
                  onValueChange={(value) => setTestTarget(value === '__none' ? '' : value)}
                >
                  <SelectTrigger
                    id="testTarget"
                    className={!testTarget ? 'text-muted-foreground' : undefined}
                  >
                    <SelectValue placeholder="Select a target..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none" className="text-muted-foreground">
                      Select a target...
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
                <Label htmlFor="testMessage">Message</Label>
                <Textarea
                  id="testMessage"
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  rows={3}
                  placeholder="Enter your test message..."
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="testImageUrl">Image URL (optional)</Label>
              <Input
                id="testImageUrl"
                value={testImageUrl}
                onChange={(e) => setTestImageUrl(e.target.value)}
                placeholder="https://example.com/image.jpg"
              />
            </div>
            <div className="flex items-center gap-4">
              <Button
                onClick={() => {
                  const payload: SendTestPayload = { jid: testTarget, message: testMessage };
                  if (testImageUrl) {
                    payload.imageUrl = testImageUrl;
                  }
                  sendTestMessage.mutate(payload);
                }}
                disabled={sendTestMessage.isPending || !testTarget || !testMessage}
              >
                {sendTestMessage.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                Send Test
              </Button>
              {sendTestMessage.isSuccess && (
                <span className="text-sm text-success">Message sent successfully!</span>
              )}
              {sendTestMessage.isError && (
                <span className="text-sm text-destructive">
                  Failed: {(sendTestMessage.error as Error)?.message || 'Unknown error'}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radio className="h-5 w-5" />
            Status Broadcast
          </CardTitle>
          <CardDescription>Post to your WhatsApp Status (visible to all contacts)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="font-medium">My Status</p>
              <p className="text-sm text-muted-foreground">Broadcast to all your contacts</p>
            </div>
            <Button
              size="sm"
              variant={existingPhones.has('status@broadcast') ? 'secondary' : 'default'}
              disabled={!isConnected || existingPhones.has('status@broadcast')}
              onClick={() =>
                addTarget.mutate({
                  name: 'My Status',
                  phone_number: 'status@broadcast',
                  type: 'status',
                  active: true
                })
              }
            >
              {existingPhones.has('status@broadcast') ? 'Added' : 'Add as Target'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Groups
            <Badge variant="secondary" className="ml-2">
              {groups.length}
            </Badge>
          </CardTitle>
          <CardDescription>WhatsApp groups you can send messages to</CardDescription>
        </CardHeader>
        <CardContent>
          {!isConnected ? (
            <p className="text-center text-muted-foreground py-8">Connect WhatsApp to see your groups</p>
          ) : groupsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : groups.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No groups found</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((group) => (
                <div key={group.jid} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{group.name}</p>
                    <p className="text-xs text-muted-foreground">{group.size} members</p>
                  </div>
                  <Button
                    size="sm"
                    variant={existingPhones.has(group.jid) ? 'secondary' : 'outline'}
                    disabled={existingPhones.has(group.jid) || addTarget.isPending}
                    onClick={() =>
                      addTarget.mutate({
                        name: group.name,
                        phone_number: group.jid,
                        type: 'group',
                        active: true
                      })
                    }
                  >
                    {existingPhones.has(group.jid) ? 'Added' : 'Add'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radio className="h-5 w-5" />
            Channels
            <Badge variant="secondary" className="ml-2">
              {channels.length}
            </Badge>
          </CardTitle>
          <CardDescription>WhatsApp channels you administer</CardDescription>
        </CardHeader>
        <CardContent>
          {!isConnected ? (
            <p className="text-center text-muted-foreground py-8">Connect WhatsApp to see your channels</p>
          ) : channelsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No channels found (you need to be an admin)</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {channels.map((channel) => (
                <div key={channel.jid} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{channel.name}</p>
                    <p className="text-xs text-muted-foreground">{channel.subscribers} subscribers</p>
                  </div>
                  <Button
                    size="sm"
                    variant={existingPhones.has(channel.jid) ? 'secondary' : 'outline'}
                    disabled={existingPhones.has(channel.jid) || addTarget.isPending}
                    onClick={() =>
                      addTarget.mutate({
                        name: channel.name,
                        phone_number: channel.jid,
                        type: 'channel',
                        active: true
                      })
                    }
                  >
                    {existingPhones.has(channel.jid) ? 'Added' : 'Add'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default WhatsAppPage;
