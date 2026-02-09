'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Target, WhatsAppChannel, WhatsAppGroup, WhatsAppStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Target as TargetIcon, Users, Radio, MessageSquare, Trash2, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

const TYPE_BADGES: Record<
  Target['type'],
  { label: string; variant: 'default' | 'secondary' | 'success' | 'warning'; icon: React.ComponentType<{ className?: string }> }
> = {
  individual: { label: 'Individual', variant: 'secondary', icon: MessageSquare },
  group: { label: 'Group', variant: 'success', icon: Users },
  channel: { label: 'Channel', variant: 'default', icon: Radio },
  status: { label: 'Status', variant: 'warning', icon: Radio }
};

type SyncTargetsResult = {
  ok: boolean;
  discovered: {
    groups: number;
    channels: number;
    status: number;
  };
  candidates: number;
  inserted: number;
  updated: number;
  unchanged: number;
  diagnostics?: {
    limitation?: string | null;
    methodErrors?: string[];
  } | null;
};

type TargetPayload = {
  name: string;
  phone_number: string;
  type: Target['type'];
  active: boolean;
  notes?: string | null;
};

const TargetsPage = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | Target['type']>('all');
  const [deleteTarget, setDeleteTarget] = useState<Target | null>(null);
  const syncInFlightRef = useRef(false);

  const { data: targets = [], isLoading: targetsLoading } = useQuery<Target[]>({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const { data: waStatus } = useQuery<WhatsAppStatus>({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 5000
  });

  const { data: waGroups = [] } = useQuery<WhatsAppGroup[]>({
    queryKey: ['whatsapp-groups'],
    queryFn: () => api.get('/api/whatsapp/groups'),
    enabled: waStatus?.status === 'connected'
  });

  const { data: waChannels = [] } = useQuery<WhatsAppChannel[]>({
    queryKey: ['whatsapp-channels'],
    queryFn: () => api.get('/api/whatsapp/channels'),
    enabled: waStatus?.status === 'connected'
  });

  const isConnected = waStatus?.status === 'connected';

  const syncTargets = useMutation({
    mutationFn: () => api.post<SyncTargetsResult>('/api/targets/sync', { includeStatus: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-groups'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-channels'] });
    }
  });

  const syncTargetsMutateRef = useRef(syncTargets.mutateAsync);

  useEffect(() => {
    syncTargetsMutateRef.current = syncTargets.mutateAsync;
  }, [syncTargets.mutateAsync]);

  // Auto-sync: runs immediately when connected, then every 60 seconds
  useEffect(() => {
    if (!isConnected) return;

    // Use a ref to track if component is mounted
    const mounted = { current: true };

    const runAutoSync = async () => {
      if (!mounted.current || syncInFlightRef.current) return;
      syncInFlightRef.current = true;
      try {
        await syncTargetsMutateRef.current();
      } catch {
        // Silently fail - will retry on next interval
      } finally {
        syncInFlightRef.current = false;
      }
    };

    // Run immediately
    void runAutoSync();

    // Then every 60 seconds
    const timer = setInterval(() => {
      void runAutoSync();
    }, 60_000);

    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [isConnected]);

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
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Connected Destinations
            </CardTitle>
            <CardDescription>Groups and channels appear here automatically.</CardDescription>
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
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Saved targets</p>
                <p className="text-xl font-semibold">{targets.length}</p>
              </div>
            </div>

            {syncTargets.isSuccess && (syncTargets.data?.discovered?.channels || 0) === 0 ? (
              <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                No channels discovered yet. Open the channel in WhatsApp on your phone, send one message there, and it will auto-sync here.
              </p>
            ) : null}
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
                {filteredTargets.map((target) => (
                  <TableRow key={target.id}>
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
                    <TableCell className="font-medium">{target.name}</TableCell>
                    <TableCell>
                      <Badge variant={TYPE_BADGES[target.type]?.variant || 'secondary'}>
                        {TYPE_BADGES[target.type]?.label || target.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden max-w-[280px] truncate text-xs text-muted-foreground md:table-cell">
                      {target.phone_number}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteTarget(target)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
