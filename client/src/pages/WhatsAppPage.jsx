import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';

const WhatsAppPage = () => {
  const queryClient = useQueryClient();

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 3000
  });

  const { data: qr } = useQuery({
    queryKey: ['whatsapp-qr'],
    queryFn: () => api.get('/api/whatsapp/qr'),
    refetchInterval: 3000,
    enabled: status?.status !== 'connected'
  });

  const { data: groups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ['whatsapp-groups'],
    queryFn: () => api.get('/api/whatsapp/groups'),
    enabled: status?.status === 'connected'
  });

  const { data: channels = [], isLoading: channelsLoading } = useQuery({
    queryKey: ['whatsapp-channels'],
    queryFn: () => api.get('/api/whatsapp/channels'),
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

  const addTarget = useMutation({
    mutationFn: (payload) => api.post('/api/targets', payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['targets'] })
  });

  const isConnected = status?.status === 'connected';
  const isQrReady = status?.status === 'qr' || status?.status === 'qr_ready';
  const existingPhones = new Set(existingTargets.map((t) => t.phone_number));

  const getStatusBadge = () => {
    if (statusLoading) return <Badge variant="secondary">Loading...</Badge>;
    if (isConnected) return <Badge variant="success">Connected</Badge>;
    if (isQrReady) return <Badge variant="warning">Scan QR Code</Badge>;
    if (status?.status === 'connecting') return <Badge variant="secondary">Connecting...</Badge>;
    return <Badge variant="destructive">{status?.status || 'Disconnected'}</Badge>;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="WhatsApp Console"
        subtitle="Connect WhatsApp to send automated messages to groups and channels."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending || !isConnected}
            >
              {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
            </Button>
            <Button onClick={() => hardRefresh.mutate()} disabled={hardRefresh.isPending}>
              {hardRefresh.isPending ? 'Refreshing...' : 'Hard Refresh'}
            </Button>
          </div>
        }
      />

      {/* Connection & QR Code */}
      <section className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Connection Status
              {getStatusBadge()}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink/60">Status</span>
                <span className="font-medium">{status?.status || 'Unknown'}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink/60">Last Connected</span>
                <span className="font-medium">
                  {status?.lastSeenAt ? new Date(status.lastSeenAt).toLocaleString() : 'Never'}
                </span>
              </div>
              {status?.lastError && (
                <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                  <strong>Error:</strong> {status.lastError}
                </div>
              )}
            </div>
            
            {!isConnected && !isQrReady && (
              <div className="rounded-lg border border-ink/10 bg-amber-50 p-3 text-sm text-amber-800">
                Click <strong>Hard Refresh</strong> to generate a new QR code.
              </div>
            )}
            
            {isConnected && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                WhatsApp is connected. You can now import groups and channels below.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>QR Code</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-[280px] items-center justify-center">
            {isConnected ? (
              <div className="text-center space-y-2">
                <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                  <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm text-ink/60">WhatsApp is connected</p>
              </div>
            ) : qr?.qr ? (
              <div className="text-center space-y-3">
                <img 
                  src={qr.qr} 
                  alt="WhatsApp QR Code" 
                  className="h-56 w-56 rounded-xl border border-ink/10 bg-white p-2" 
                />
                <p className="text-sm text-ink/60">Scan with WhatsApp on your phone</p>
              </div>
            ) : (
              <div className="text-center space-y-2">
                <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-ink/5 animate-pulse">
                  <svg className="h-8 w-8 text-ink/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                </div>
                <p className="text-sm text-ink/50">Waiting for QR code...</p>
                <p className="text-xs text-ink/40">Click Hard Refresh if nothing appears</p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Status Broadcast */}
      <Card>
        <CardHeader>
          <CardTitle>Status Broadcast</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-ink/10 bg-white/50 p-4">
            <div>
              <p className="font-medium">My Status</p>
              <p className="text-sm text-ink/60">Post to your WhatsApp Status (visible to contacts)</p>
            </div>
            <Button
              size="sm"
              variant="outline"
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
            Groups
            <Badge variant="secondary">{groups.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!isConnected ? (
            <p className="text-center text-ink/50 py-8">Connect WhatsApp to see your groups</p>
          ) : groupsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink/20 border-t-ink"></div>
            </div>
          ) : groups.length === 0 ? (
            <p className="text-center text-ink/50 py-8">No groups found</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((group) => (
                <div
                  key={group.jid}
                  className="flex items-center justify-between rounded-lg border border-ink/10 bg-white/50 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{group.name}</p>
                    <p className="text-xs text-ink/50">{group.size} members</p>
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
            Channels
            <Badge variant="secondary">{channels.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!isConnected ? (
            <p className="text-center text-ink/50 py-8">Connect WhatsApp to see your channels</p>
          ) : channelsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink/20 border-t-ink"></div>
            </div>
          ) : channels.length === 0 ? (
            <p className="text-center text-ink/50 py-8">No channels found (you need to be an admin)</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {channels.map((channel) => (
                <div
                  key={channel.jid}
                  className="flex items-center justify-between rounded-lg border border-ink/10 bg-white/50 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{channel.name}</p>
                    <p className="text-xs text-ink/50">{channel.subscribers} subscribers</p>
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
