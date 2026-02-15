'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Target, WhatsAppChannel, WhatsAppGroup, WhatsAppStatus } from '@/lib/types';
import { normalizeDisplayText, normalizeTargetName } from '@/lib/targetUtils';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Target as TargetIcon, Users, Radio, MessageSquare, Trash2, AlertTriangle, Loader2, RefreshCw, Plus, Pencil, Save, X } from 'lucide-react';

const TYPE_BADGES: Record<
  Target['type'],
  { label: string; variant: 'default' | 'secondary' | 'success' | 'warning'; icon: React.ComponentType<{ className?: string }> }
> = {
  individual: { label: 'Individual', variant: 'secondary', icon: MessageSquare },
  group: { label: 'Group', variant: 'success', icon: Users },
  channel: { label: 'Channel', variant: 'default', icon: Radio },
  status: { label: 'Status', variant: 'warning', icon: Radio }
};

type TargetPayload = {
  name: string;
  phone_number: string;
  type: Target['type'];
  active: boolean;
  notes?: string | null;
  message_delay_ms_override?: number | null;
  inter_target_delay_sec_override?: number | null;
  intra_target_delay_sec_override?: number | null;
};

type ChannelDiagnostics = {
  methodsTried?: string[];
  methodErrors?: string[];
  sourceCounts?: {
    api?: number;
    cache?: number;
    metadata?: number;
    store?: number;
  };
  seeded?: {
    provided?: number;
    verified?: number;
    failed?: number;
    failedJids?: string[];
  };
  limitation?: string | null;
};

type ChannelDiagnosticsResponse = {
  channels?: WhatsAppChannel[];
  diagnostics?: ChannelDiagnostics;
};

type DiscoverChannelsResponse = {
  ok?: boolean;
  discovered?: number;
  channels?: WhatsAppChannel[];
  diagnostics?: ChannelDiagnostics;
  persisted?: {
    candidates?: number;
  };
};

const TargetsPage = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | Target['type']>('all');
  const [addValue, setAddValue] = useState('');
  const [addNotice, setAddNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [discoveryNotice, setDiscoveryNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Target | null>(null);
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [delayDraft, setDelayDraft] = useState<{
    message_delay_ms_override: string;
    inter_target_delay_sec_override: string;
    intra_target_delay_sec_override: string;
  }>({
    message_delay_ms_override: '',
    inter_target_delay_sec_override: '',
    intra_target_delay_sec_override: ''
  });

  const { data: targets = [], isLoading: targetsLoading } = useQuery<Target[]>({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const { data: waStatus } = useQuery<WhatsAppStatus>({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 5000
  });
  const isConnected = waStatus?.status === 'connected';

  const { data: waGroupsRaw } = useQuery<unknown>({
    queryKey: ['whatsapp-groups'],
    queryFn: () => api.get('/api/whatsapp/groups'),
    enabled: isConnected
  });

  const { data: waChannelsRaw } = useQuery<unknown>({
    queryKey: ['whatsapp-channels'],
    queryFn: () => api.get('/api/whatsapp/channels'),
    enabled: isConnected
  });

  const { data: channelDiagnosticsRaw, refetch: refetchChannelDiagnostics } = useQuery<ChannelDiagnosticsResponse>({
    queryKey: ['whatsapp-channels-diagnostics'],
    queryFn: () => api.get('/api/whatsapp/channels/diagnostics'),
    enabled: isConnected
  });

  const waGroups = React.useMemo<WhatsAppGroup[]>(() => {
    if (!Array.isArray(waGroupsRaw)) return [];
    return waGroupsRaw.filter((entry): entry is WhatsAppGroup => Boolean(entry && typeof entry === 'object' && (entry as WhatsAppGroup).jid));
  }, [waGroupsRaw]);

  const waChannels = React.useMemo<WhatsAppChannel[]>(() => {
    if (!Array.isArray(waChannelsRaw)) return [];
    return waChannelsRaw
      .filter((entry): entry is WhatsAppChannel => Boolean(entry && typeof entry === 'object' && (entry as WhatsAppChannel).jid))
      .map((channel) => {
        const jid = normalizeDisplayText(channel.jid);
        const cleanName = normalizeTargetName(channel.name, 'channel', jid);
        return {
          ...channel,
          jid,
          name: cleanName || ''
        };
      })
      .filter((channel) => Boolean(channel.name));
  }, [waChannelsRaw]);

  const liveChannelCount = waChannels.filter((channel) => channel.source === 'live').length;
  const channelDiagnostics = channelDiagnosticsRaw?.diagnostics;
  const channelMethodErrors = Array.isArray(channelDiagnostics?.methodErrors)
    ? channelDiagnostics?.methodErrors?.slice(0, 3)
    : [];

  const updateTarget = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: TargetPayload }) => api.put(`/api/targets/${id}`, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['targets'] })
  });

  const removeTarget = useMutation({
    mutationFn: (id: string) => api.delete(`/api/targets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      setDeleteTarget(null);
    }
  });

  const addResolvedTarget = useMutation({
    mutationFn: (value: string) => api.post('/api/whatsapp/resolve-target', { value, type: 'auto' }),
    onSuccess: () => {
      setAddNotice({ type: 'success', message: 'Destination added from WhatsApp.' });
      setAddValue('');
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels'] });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Could not resolve this destination';
      setAddNotice({ type: 'error', message });
    }
  });

  const discoverChannels = useMutation({
    mutationFn: () => api.post<DiscoverChannelsResponse>('/api/whatsapp/channels/discover'),
    onSuccess: async (result) => {
      setDiscoveryNotice({
        type: 'success',
        message: `Discovery complete: ${Number(result?.discovered || 0)} channels found.`
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['targets'] }),
        queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] }),
        queryClient.invalidateQueries({ queryKey: ['whatsapp-channels'] }),
        queryClient.invalidateQueries({ queryKey: ['whatsapp-channels-diagnostics'] })
      ]);
      await refetchChannelDiagnostics();
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Channel discovery failed';
      setDiscoveryNotice({ type: 'error', message });
    }
  });

  const filteredTargets = targets.filter((target) => {
    const matchesSearch =
      !search ||
      target.name.toLowerCase().includes(search.toLowerCase()) ||
      target.phone_number.toLowerCase().includes(search.toLowerCase());
    const matchesType = filterType === 'all' || target.type === filterType;
    return matchesSearch && matchesType;
  });

  const counts: Record<'all' | Target['type'], number> = {
    all: targets.length,
    group: targets.filter((target) => target.type === 'group').length,
    channel: targets.filter((target) => target.type === 'channel').length,
    status: targets.filter((target) => target.type === 'status').length,
    individual: targets.filter((target) => target.type === 'individual').length
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Targets</h1>
        <p className="text-muted-foreground">Destinations are synced automatically from your connected WhatsApp account.</p>
      </div>

      {!isConnected ? (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="flex items-start gap-4 pt-6">
            <div className="rounded-full bg-warning/20 p-2">
              <AlertTriangle className="h-5 w-5 text-warning-foreground" />
            </div>
            <div className="flex-1">
              <h3 className="font-medium">WhatsApp not connected</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Connect WhatsApp once. Groups/channels/status will sync here automatically.
              </p>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <Link href="/whatsapp">Open WhatsApp Console</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <RefreshCw className="h-5 w-5" />
                  Connected Destinations
                </CardTitle>
                <CardDescription>Groups and channels are discovered from your live WhatsApp session.</CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => discoverChannels.mutate()}
                disabled={discoverChannels.isPending}
              >
                {discoverChannels.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Discover channels now
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Groups</p>
                <p className="text-xl font-semibold">{waGroups.length}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Channels</p>
                <p className="text-xl font-semibold">{waChannels.length}</p>
                {liveChannelCount > 0 ? (
                  <p className="text-[11px] text-muted-foreground">Live: {liveChannelCount}</p>
                ) : null}
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Saved targets</p>
                <p className="text-xl font-semibold">{targets.length}</p>
              </div>
            </div>
            {discoveryNotice ? (
              <p className={discoveryNotice.type === 'success' ? 'rounded-md bg-success/10 px-3 py-2 text-xs text-success' : 'rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive'}>
                {discoveryNotice.message}
              </p>
            ) : null}
            {isConnected && waChannels.length === 0 ? (
              <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                No channels discovered yet. Open the channel in WhatsApp mobile/web, then click Discover channels now.
              </p>
            ) : null}
            {channelDiagnostics?.limitation && waChannels.length === 0 ? (
              <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
                Live channel list is not available in this session yet. Open your channels in WhatsApp, then run discovery again.
              </p>
            ) : null}
            {channelMethodErrors.length ? (
              <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning-foreground">
                <p className="font-medium">Discovery warnings</p>
                <p className="mt-1">{channelMethodErrors.join(' | ')}</p>
              </div>
            ) : null}
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">Add from WhatsApp link or JID</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder="Paste link/JID: chat.whatsapp.com/... or whatsapp.com/channel/..."
                  value={addValue}
                  onChange={(event) => setAddValue(event.target.value)}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  onClick={() => {
                    const value = String(addValue || '').trim();
                    if (!value) return;
                    addResolvedTarget.mutate(value);
                  }}
                  disabled={addResolvedTarget.isPending || !String(addValue || '').trim()}
                >
                  {addResolvedTarget.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                  Add
                </Button>
              </div>
              {addNotice ? (
                <p className={addNotice.type === 'success' ? 'text-xs text-success' : 'text-xs text-destructive'}>
                  {addNotice.message}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Works with group links, channel links, direct JIDs, status, or phone numbers.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <TargetIcon className="h-5 w-5" />
                Synced Targets
              </CardTitle>
              <CardDescription>{targets.length} target{targets.length !== 1 ? 's' : ''} available</CardDescription>
            </div>
            <Input
              placeholder="Search targets..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-full sm:w-56"
            />
          </div>

          <div className="flex flex-wrap gap-1 pt-2">
            {(['all', 'group', 'channel', 'status', 'individual'] as const).map((type) => (
              <Button
                key={type}
                size="sm"
                variant={filterType === type ? 'default' : 'outline'}
                onClick={() => setFilterType(type)}
              >
                {type === 'all' ? 'All' : TYPE_BADGES[type].label}
                <Badge variant="secondary" className="ml-1.5">
                  {counts[type]}
                </Badge>
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {targetsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredTargets.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {targets.length === 0 ? 'No targets yet. Connect WhatsApp and wait for auto sync.' : 'No targets match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell className="w-12">Active</TableHeaderCell>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell className="hidden md:table-cell">Address</TableHeaderCell>
                    <TableHeaderCell className="w-20">Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTargets.map((target) => {
                    const isEditing = editingTargetId === target.id;
                    const openDelayEditor = () => {
                      setEditingTargetId(target.id);
                      setDelayDraft({
                        message_delay_ms_override:
                          target.message_delay_ms_override == null ? '' : String(target.message_delay_ms_override),
                        inter_target_delay_sec_override:
                          target.inter_target_delay_sec_override == null ? '' : String(target.inter_target_delay_sec_override),
                        intra_target_delay_sec_override:
                          target.intra_target_delay_sec_override == null ? '' : String(target.intra_target_delay_sec_override)
                      });
                    };

                    const parseOptionalInt = (value: string, options: { min: number; max: number }) => {
                      const raw = String(value || '').trim();
                      if (!raw) return null;
                      const parsed = Number(raw);
                      if (!Number.isFinite(parsed)) return null;
                      const clamped = Math.min(Math.max(Math.floor(parsed), options.min), options.max);
                      return clamped;
                    };

                    const saveDelayOverrides = () => {
                      updateTarget.mutate(
                        {
                          id: target.id,
                          payload: {
                            name: target.name,
                            phone_number: target.phone_number,
                            type: target.type,
                            active: target.active,
                            notes: target.notes || null,
                            message_delay_ms_override: parseOptionalInt(delayDraft.message_delay_ms_override, { min: 0, max: 60000 }),
                            inter_target_delay_sec_override: parseOptionalInt(delayDraft.inter_target_delay_sec_override, { min: 0, max: 600 }),
                            intra_target_delay_sec_override: parseOptionalInt(delayDraft.intra_target_delay_sec_override, { min: 0, max: 600 })
                          }
                        },
                        {
                          onSuccess: () => {
                            setEditingTargetId(null);
                          }
                        }
                      );
                    };

                    const cancelDelayOverrides = () => {
                      setEditingTargetId(null);
                      setDelayDraft({
                        message_delay_ms_override: '',
                        inter_target_delay_sec_override: '',
                        intra_target_delay_sec_override: ''
                      });
                    };

                    return (
                      <React.Fragment key={target.id}>
                        <TableRow>
                          <TableCell>
                            <Checkbox
                              checked={target.active}
                              onCheckedChange={(checked) =>
                                updateTarget.mutate({
                                  id: target.id,
                                  payload: {
                                    name: target.name,
                                    phone_number: target.phone_number,
                                    type: target.type,
                                    active: checked === true,
                                    notes: target.notes || null
                                  }
                                })
                              }
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="min-w-0">
                              <p className="truncate">{target.name}</p>
                              {target.notes ? <p className="truncate text-xs text-muted-foreground">{target.notes}</p> : null}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={TYPE_BADGES[target.type]?.variant || 'secondary'}>
                              {TYPE_BADGES[target.type]?.label || target.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden max-w-[280px] truncate text-xs text-muted-foreground md:table-cell">
                            {target.phone_number}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={openDelayEditor}
                                title="Edit per-target delays"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDeleteTarget(target)}
                                className="text-destructive hover:text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>

                        {isEditing ? (
                          <TableRow>
                            <TableCell colSpan={5} className="bg-muted/20">
                              <div className="grid gap-3 sm:grid-cols-3">
                                <div className="space-y-1.5">
                                  <Label htmlFor={`delay_ms_${target.id}`}>Message delay override (ms)</Label>
                                  <Input
                                    id={`delay_ms_${target.id}`}
                                    type="number"
                                    min={0}
                                    max={60000}
                                    placeholder="Default"
                                    value={delayDraft.message_delay_ms_override}
                                    onChange={(event) =>
                                      setDelayDraft((current) => ({ ...current, message_delay_ms_override: event.target.value }))
                                    }
                                  />
                                  <p className="text-[11px] text-muted-foreground">Blank = use global setting.</p>
                                </div>
                                <div className="space-y-1.5">
                                  <Label htmlFor={`delay_inter_${target.id}`}>Between targets override (sec)</Label>
                                  <Input
                                    id={`delay_inter_${target.id}`}
                                    type="number"
                                    min={0}
                                    max={600}
                                    placeholder="Default"
                                    value={delayDraft.inter_target_delay_sec_override}
                                    onChange={(event) =>
                                      setDelayDraft((current) => ({
                                        ...current,
                                        inter_target_delay_sec_override: event.target.value
                                      }))
                                    }
                                  />
                                  <p className="text-[11px] text-muted-foreground">Blank = use global setting.</p>
                                </div>
                                <div className="space-y-1.5">
                                  <Label htmlFor={`delay_intra_${target.id}`}>Within one target override (sec)</Label>
                                  <Input
                                    id={`delay_intra_${target.id}`}
                                    type="number"
                                    min={0}
                                    max={600}
                                    placeholder="Default"
                                    value={delayDraft.intra_target_delay_sec_override}
                                    onChange={(event) =>
                                      setDelayDraft((current) => ({
                                        ...current,
                                        intra_target_delay_sec_override: event.target.value
                                      }))
                                    }
                                  />
                                  <p className="text-[11px] text-muted-foreground">Blank = use global setting.</p>
                                </div>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Button size="sm" onClick={saveDelayOverrides} disabled={updateTarget.isPending}>
                                  {updateTarget.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                                  Save delays
                                </Button>
                                <Button size="sm" variant="outline" onClick={cancelDelayOverrides}>
                                  <X className="mr-2 h-4 w-4" />
                                  Cancel
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Target</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{deleteTarget?.name}&quot; from this app? This does not remove the real WhatsApp chat/group/channel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && removeTarget.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TargetsPage;
