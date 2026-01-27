import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';

const WhatsAppPage = () => {
  const queryClient = useQueryClient();

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 5000
  });

  const { data: qr } = useQuery({
    queryKey: ['whatsapp-qr'],
    queryFn: () => api.get('/api/whatsapp/qr'),
    refetchInterval: 5000,
    enabled: status?.status !== 'connected'
  });

  const { data: groups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ['whatsapp-groups'],
    queryFn: () => api.get('/api/whatsapp/groups'),
    refetchInterval: 30000,
    enabled: status?.status === 'connected'
  });

  const { data: channels = [], isLoading: channelsLoading } = useQuery({
    queryKey: ['whatsapp-channels'],
    queryFn: () => api.get('/api/whatsapp/channels'),
    refetchInterval: 30000,
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
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels'] });
    }
  });

  const addTarget = useMutation({
    mutationFn: (payload) => api.post('/api/targets', payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['targets'] })
  });

  const isConnected = status?.status === 'connected';
  const existingJids = new Set(existingTargets.map((t) => t.jid));

  return (
    <div className="space-y-8">
      <PageHeader
        title="WhatsApp Console"
        subtitle="Scan the QR to link WhatsApp Web and monitor live connection status."
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

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Connection Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              {statusLoading ? (
                <Badge variant="secondary">Loading...</Badge>
              ) : (
                <Badge variant={isConnected ? 'success' : status?.status === 'qr' ? 'warning' : 'danger'}>
                  {status?.status || 'unknown'}
                </Badge>
              )}
              <p className="text-sm text-ink/60">
                Last seen: {status?.lastSeenAt ? new Date(status.lastSeenAt).toLocaleString() : '—'}
              </p>
            </div>
            <p className="text-sm text-ink/60">
              {status?.lastError ? `Last error: ${status.lastError}` : 'No errors detected in the last session.'}
            </p>
            <div className="rounded-2xl border border-ink/10 bg-white/70 p-4 text-sm text-ink/60">
              Keep the connection warm with the Render uptime endpoint. QR refreshes in-app automatically.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>QR Code</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-[260px] items-center justify-center">
            {qr?.qr ? (
              <img src={qr.qr} alt="WhatsApp QR" className="h-52 w-52 rounded-xl border border-ink/10 bg-white p-3" />
            ) : (
              <div className="text-center text-sm text-ink/50">
                {isConnected ? 'Already connected ✓' : 'Waiting for a fresh QR code...'}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Status Broadcast Target */}
      <Card>
        <CardHeader>
          <CardTitle>Status Broadcast</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-2xl border border-ink/10 bg-surface p-4">
            <div>
              <p className="font-medium">My Status</p>
              <p className="text-sm text-ink/60">Post to your WhatsApp Status (visible to contacts)</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!isConnected || existingJids.has('status@broadcast')}
              onClick={() =>
                addTarget.mutate({
                  name: 'My Status',
                  jid: 'status@broadcast',
                  type: 'status',
                  enabled: true
                })
              }
            >
              {existingJids.has('status@broadcast') ? 'Added ✓' : 'Add as Target'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Groups */}
      <Card>
        <CardHeader>
          <CardTitle>Groups ({groups.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {groupsLoading ? (
            <p className="text-center text-ink/50 py-4">Loading groups...</p>
          ) : !isConnected ? (
            <p className="text-center text-ink/50 py-4">Connect WhatsApp to load groups</p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Group</TableHeaderCell>
                  <TableHeaderCell>Members</TableHeaderCell>
                  <TableHeaderCell>Action</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {groups.map((group) => (
                  <TableRow key={group.jid}>
                    <TableCell>{group.name}</TableCell>
                    <TableCell>{group.size}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={existingJids.has(group.jid)}
                        onClick={() =>
                          addTarget.mutate({ name: group.name, jid: group.jid, type: 'group', enabled: true })
                        }
                      >
                        {existingJids.has(group.jid) ? 'Added ✓' : 'Add'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {groups.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-ink/50">
                      No groups found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Channels */}
      <Card>
        <CardHeader>
          <CardTitle>Channels ({channels.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {channelsLoading ? (
            <p className="text-center text-ink/50 py-4">Loading channels...</p>
          ) : !isConnected ? (
            <p className="text-center text-ink/50 py-4">Connect WhatsApp to load channels</p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Channel</TableHeaderCell>
                  <TableHeaderCell>Subscribers</TableHeaderCell>
                  <TableHeaderCell>Action</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {channels.map((channel) => (
                  <TableRow key={channel.jid}>
                    <TableCell>{channel.name}</TableCell>
                    <TableCell>{channel.subscribers}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={existingJids.has(channel.jid)}
                        onClick={() =>
                          addTarget.mutate({ name: channel.name, jid: channel.jid, type: 'channel', enabled: true })
                        }
                      >
                        {existingJids.has(channel.jid) ? 'Added ✓' : 'Add'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {channels.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-ink/50">
                      No channels found. Channels may require admin access.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default WhatsAppPage;
