import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { RefreshCw, Power, CheckCircle, QrCode, Users, Radio, Loader2, Send, MessageSquare } from 'lucide-react';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

const WhatsAppPage = () => {
  const queryClient = useQueryClient();
  const [testTarget, setTestTarget] = React.useState('');
  const [testMessage, setTestMessage] = React.useState('Hello from WhatsApp News Bot!');
  const [testMediaUrl, setTestMediaUrl] = React.useState('');
  const [testMediaType, setTestMediaType] = React.useState('image');
  const [manualChannel, setManualChannel] = React.useState('');
  const [manualChannelName, setManualChannelName] = React.useState('');

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 10000
  });

  const { data: qr } = useQuery({
    queryKey: ['whatsapp-qr'],
    queryFn: () => api.get('/api/whatsapp/qr'),
    refetchInterval: 10000,
    enabled: status?.status !== 'connected'
  });

  const { data: groups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ['whatsapp-groups'],
    queryFn: () => api.get('/api/whatsapp/groups'),
    enabled: status?.status === 'connected'
  });

  const { data: channelsResponse, isLoading: channelsLoading } = useQuery({
    queryKey: ['whatsapp-channels-diagnostics'],
    queryFn: () => api.get('/api/whatsapp/channels/diagnostics'),
    enabled: status?.status === 'connected'
  });

  const { data: existingTargets = [] } = useQuery({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const disconnect = useMutation({
    mutationFn: () => api.post('/api/whatsapp/disconnect'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels-diagnostics'] });
    }
  });

  const reconnect = useMutation({
    mutationFn: () => api.post('/api/whatsapp/reconnect'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels-diagnostics'] });
    }
  });

  const hardRefresh = useMutation({
    mutationFn: () => api.post('/api/whatsapp/hard-refresh'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels-diagnostics'] });
    }
  });

  const clearSenderKeys = useMutation({
    mutationFn: () => api.post('/api/whatsapp/clear-sender-keys'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels-diagnostics'] });
    }
  });

  const takeover = useMutation({
    mutationFn: () => api.post('/api/whatsapp/takeover'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels-diagnostics'] });
    }
  });

  const addTarget = useMutation({
    mutationFn: (payload) => api.post('/api/targets', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels-diagnostics'] });
    }
  });

  const addManualChannel = useMutation({
    mutationFn: async () => {
      const rawChannel = String(manualChannel || '').trim();
      if (!rawChannel) {
        throw new Error('Channel ID/JID is required');
      }

      const resolved = await api.post('/api/whatsapp/channels/resolve', {
        channel: rawChannel,
        name: String(manualChannelName || '').trim() || undefined
      });

      const channel = resolved?.channel;
      if (!channel?.jid) {
        throw new Error('Could not resolve channel JID');
      }

      if (channel.canSend === false) {
        const roleText = channel.viewerRole ? ` (role: ${channel.viewerRole})` : '';
        throw new Error(`This WhatsApp account cannot post to that channel${roleText}`);
      }

      if (!existingPhones.has(channel.jid)) {
        await api.post('/api/targets', {
          name: String(manualChannelName || '').trim() || channel.name || channel.jid,
          phone_number: channel.jid,
          type: 'channel',
          active: true,
          notes: Number(channel.subscribers || 0) > 0 ? `${Number(channel.subscribers)} subscribers` : null
        });
      }

      return resolved;
    },
    onSuccess: () => {
      setManualChannel('');
      setManualChannelName('');
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels-diagnostics'] });
    }
  });

  const sendTestMessage = useMutation({
    mutationFn: (payload) => api.post('/api/whatsapp/send-test', payload),
    onSuccess: () => {
      setTestMessage('Hello from WhatsApp News Bot!');
      setTestMediaUrl('');
      setTestMediaType('image');
    }
  });

  const isConnected = status?.status === 'connected';
  const isQrReady = status?.status === 'qr' || status?.status === 'qr_ready';
  const isConflict = status?.status === 'conflict';
  const channels = channelsResponse?.channels || [];
  const channelLimitation = channelsResponse?.diagnostics?.limitation || null;
  const existingPhones = new Set(existingTargets.map((t) => t.phone_number));
  const activeTargets = existingTargets.filter((target) => target.active);

  const getStatusBadge = () => {
    if (statusLoading) return <Badge variant="secondary">Loading...</Badge>;
    if (isConnected) return <Badge variant="success">Connected</Badge>;
    if (isQrReady) return <Badge variant="warning">Scan QR Code</Badge>;
    if (status?.status === 'connecting' || status?.status === 'conflict') return <Badge variant="secondary">Connecting...</Badge>;
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
            onClick={() => reconnect.mutate()}
            disabled={reconnect.isPending || isConnected}
            title="Reconnect using existing session (no QR reset)"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${reconnect.isPending ? 'animate-spin' : ''}`} />
            {reconnect.isPending ? 'Reconnecting...' : 'Reconnect'}
          </Button>
          <Button onClick={() => hardRefresh.mutate()} disabled={hardRefresh.isPending}>
            <RefreshCw className={`mr-2 h-4 w-4 ${hardRefresh.isPending ? 'animate-spin' : ''}`} />
            {hardRefresh.isPending ? 'Resetting...' : 'Hard Refresh (Reset Session)'}
          </Button>
          <Button
            variant="outline"
            onClick={() => clearSenderKeys.mutate()}
            disabled={clearSenderKeys.isPending}
            title="Fix group send failures caused by sender-key corruption"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${clearSenderKeys.isPending ? 'animate-spin' : ''}`} />
            {clearSenderKeys.isPending ? 'Clearing Keys...' : 'Clear Sender Keys'}
          </Button>


        </div>
      </div>

      {/* Connection & QR Code */}
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
              {status?.lease?.supported && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Session</span>
                  <span className="font-medium text-xs">
                    {status.lease.held ? 'Active' : 'Initializing...'}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last Connected</span>
                <span className="font-medium">
                  {status?.lastSeenAt ? new Date(status.lastSeenAt).toLocaleString() : 'Never'}
                </span>
              </div>
              {status?.me?.jid && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Connected As</span>
                  <span className="font-medium font-mono text-xs">{status.me.jid}</span>
                </div>
              )}
            </div>
            
            {status?.lastError && !status.lastError.includes('Taking over') && (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <strong>Error:</strong> {status.lastError}
              </div>
            )}
            
            {status?.lastError?.includes('Taking over') && (
              <div className="rounded-lg bg-secondary/50 p-3 text-sm">
                <RefreshCw className="inline h-4 w-4 mr-2 animate-spin" />
                Connecting to WhatsApp...
              </div>
            )}

            {takeover.isSuccess && (
              <div className="rounded-lg bg-success/10 p-3 text-sm text-success">
                Lease takeover requested. Reconnecting...
              </div>
            )}

            {clearSenderKeys.isSuccess && (
              <div className="rounded-lg bg-success/10 p-3 text-sm text-success">
                Sender keys cleared. Reconnecting...
              </div>
            )}

            {reconnect.isSuccess && (
              <div className="rounded-lg bg-success/10 p-3 text-sm text-success">
                Reconnect requested. Waiting for WhatsApp session...
              </div>
            )}
             
            {!isConnected && !isQrReady && (
              <div className="rounded-lg bg-warning/10 p-3 text-sm text-warning-foreground">
                Try <strong>Reconnect</strong> first. If login still fails, use <strong>Hard Refresh (Reset Session)</strong> for a new QR.
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
                <img 
                  src={qr.qr} 
                  alt="WhatsApp QR Code" 
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

      {/* Test Message */}
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
                <Select value={testTarget || undefined} onValueChange={setTestTarget}>
                  <SelectTrigger id="testTarget">
                    <SelectValue placeholder="Select a target..." />
                  </SelectTrigger>
                  <SelectContent>
                    {activeTargets.length > 0 ? (
                      activeTargets.map((target) => (
                        <SelectItem key={target.id} value={target.phone_number}>
                          {target.name} ({target.type})
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="__none" disabled>
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
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="testMediaUrl">Media URL (optional)</Label>
                <Input
                  id="testMediaUrl"
                  value={testMediaUrl}
                  onChange={(e) => setTestMediaUrl(e.target.value)}
                  placeholder="https://example.com/media.mp4"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="testMediaType">Media Type</Label>
                <Select value={testMediaType} onValueChange={setTestMediaType}>
                  <SelectTrigger id="testMediaType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="image">Image</SelectItem>
                    <SelectItem value="video">Video</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Button
                onClick={() => {
                  const payload = { jid: testTarget, message: testMessage, confirm: true };
                  if (testMediaUrl.trim()) {
                    payload.mediaUrl = testMediaUrl.trim();
                    payload.mediaType = testMediaType;
                  }
                  sendTestMessage.mutate(payload);
                }}
                disabled={sendTestMessage.isPending || !testTarget || (!testMessage.trim() && !testMediaUrl.trim())}
              >
                {sendTestMessage.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                Send Test
              </Button>
              {sendTestMessage.isSuccess && (
                <span className="text-sm text-success">
                  Sent{sendTestMessage.data?.messageId ? ` (${sendTestMessage.data.messageId})` : ''}
                  {sendTestMessage.data?.confirmation
                    ? sendTestMessage.data.confirmation.ok
                      ? ` - Confirmed via ${sendTestMessage.data.confirmation.via}`
                      : ' - Not confirmed'
                    : ''}
                </span>
              )}
              {sendTestMessage.isError && (
                <span className="text-sm text-destructive">
                  Failed: {sendTestMessage.error?.message || 'Unknown error'}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Status Broadcast */}
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

      {/* Groups */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Groups
            <Badge variant="secondary" className="ml-2">{groups.length}</Badge>
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
                <div
                  key={group.jid}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
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

      {/* Channels */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radio className="h-5 w-5" />
            Channels
            <Badge variant="secondary" className="ml-2">{channels.length}</Badge>
          </CardTitle>
          <CardDescription>WhatsApp channels you administer</CardDescription>
        </CardHeader>
        <CardContent>
          {isConnected && (
            <div className="mb-4 rounded-lg border p-4 space-y-3">
              <p className="text-sm font-medium">Add Channel by ID/JID</p>
              <p className="text-xs text-muted-foreground">
                Use a numeric channel ID, invite code, channel URL, or full JID like <span className="font-mono">1203630...@newsletter</span>. The server resolves live metadata when available.
              </p>
              <div className="grid gap-2 md:grid-cols-[2fr_2fr_auto]">
                <Input
                  value={manualChannel}
                  onChange={(e) => setManualChannel(e.target.value)}
                  placeholder="Channel ID, URL, invite code, or JID"
                />
                <Input
                  value={manualChannelName}
                  onChange={(e) => setManualChannelName(e.target.value)}
                  placeholder="Optional display name"
                />
                <Button
                  onClick={() => addManualChannel.mutate()}
                  disabled={addManualChannel.isPending || !String(manualChannel || '').trim()}
                >
                  {addManualChannel.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Add Channel
                </Button>
              </div>
              {addManualChannel.isSuccess && (
                <p className="text-xs text-success">
                  Channel added{addManualChannel.data?.found ? ' using live metadata.' : ' with canonical JID fallback.'}
                </p>
              )}
              {addManualChannel.isError && (
                <p className="text-xs text-destructive">
                  {addManualChannel.error?.message || 'Failed to add channel'}
                </p>
              )}
            </div>
          )}

          {!isConnected ? (
            <p className="text-center text-muted-foreground py-8">Connect WhatsApp to see your channels</p>
          ) : channelsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">{channelLimitation || 'No channels auto-discovered yet. Add one by ID/JID above.'}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {channels.map((channel) => (
                <div
                  key={channel.jid}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{channel.name}</p>
                    <p className="text-xs text-muted-foreground">{channel.subscribers} subscribers</p>
                    {channel.canSend === false ? (
                      <p className="text-xs text-destructive">No post permission for this account</p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant={existingPhones.has(channel.jid) ? 'secondary' : 'outline'}
                    disabled={existingPhones.has(channel.jid) || addTarget.isPending || channel.canSend === false}
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
