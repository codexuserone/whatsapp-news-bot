'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Schedule, Target, WhatsAppStatus } from '@/lib/types';
import { isTestTarget } from '@/lib/targetUtils';
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
import { Target as TargetIcon, Users, Radio, MessageSquare, Trash2, AlertTriangle, Loader2 } from 'lucide-react';

const TYPE_BADGES: Record<
  Target['type'],
  { label: string; variant: 'default' | 'secondary' | 'success' | 'warning'; icon: React.ComponentType<{ className?: string }> }
> = {
  individual: { label: 'Private', variant: 'secondary', icon: MessageSquare },
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
};

const TargetsPage = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | Target['type']>('all');
  const [showTestDestinations, setShowTestDestinations] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Target | null>(null);

  const { data: targets = [], isLoading: targetsLoading } = useQuery<Target[]>({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets'),
    refetchInterval: 60000
  });

  const { data: schedules = [] } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: () => api.get('/api/schedules'),
    refetchInterval: 60000
  });

  const { data: waStatus } = useQuery<WhatsAppStatus>({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 30000
  });

  const isConnected = waStatus?.status === 'connected';

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

  const visibleTargets = React.useMemo(
    () => targets.filter((target) => showTestDestinations || !isTestTarget(target)),
    [targets, showTestDestinations]
  );
  const hiddenTestTargetCount = targets.length - visibleTargets.length;

  const runningSchedules = React.useMemo(
    () =>
      schedules.filter((schedule) => {
        const state = String(schedule.state || '').trim().toLowerCase();
        return schedule.active !== false && (state === '' || state === 'active');
      }),
    [schedules]
  );

  const targetUsageById = React.useMemo(() => {
    const usage = new Map<string, Schedule[]>();
    for (const schedule of runningSchedules) {
      for (const targetId of schedule.target_ids || []) {
        const key = String(targetId || '').trim();
        if (!key) continue;
        usage.set(key, [...(usage.get(key) || []), schedule]);
      }
    }
    return usage;
  }, [runningSchedules]);

  const filteredTargets = visibleTargets.filter((target) => {
    const searchTerm = search.toLowerCase();
    const matchesSearch =
      !search ||
      target.name.toLowerCase().includes(searchTerm) ||
      target.phone_number.toLowerCase().includes(searchTerm);
    const matchesType = filterType === 'all' || target.type === filterType;
    return matchesSearch && matchesType;
  });

  const counts: Record<'all' | Target['type'], number> = {
    all: visibleTargets.length,
    group: visibleTargets.filter((target) => target.type === 'group').length,
    channel: visibleTargets.filter((target) => target.type === 'channel').length,
    individual: visibleTargets.filter((target) => target.type === 'individual').length,
    status: visibleTargets.filter((target) => target.type === 'status').length
  };

  const updateActive = (target: Target, active: boolean) => {
    updateTarget.mutate({
      id: target.id,
      payload: {
        name: target.name,
        phone_number: target.phone_number,
        type: target.type,
        active,
        notes: target.notes || null
      }
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Destinations</h1>
        <p className="text-muted-foreground">
          Groups, channels, private recipients, and Status sync from the connected WhatsApp account.
        </p>
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
                Connect WhatsApp once. Destinations will sync here automatically.
              </p>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <Link href="/whatsapp">Open WhatsApp</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <TargetIcon className="h-5 w-5" />
                Destinations
              </CardTitle>
              <CardDescription>
                {visibleTargets.length} destination{visibleTargets.length !== 1 ? 's' : ''} available
              </CardDescription>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              {hiddenTestTargetCount > 0 ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setShowTestDestinations((current) => !current)}>
                  {showTestDestinations ? 'Hide test' : `Show ${hiddenTestTargetCount} test`}
                </Button>
              ) : null}
              <Input
                placeholder="Search destinations..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-full sm:w-56"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-1 pt-2">
            {(['all', 'group', 'channel', 'individual', 'status'] as const).map((type) => (
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
              {visibleTargets.length === 0
                ? 'No destinations yet. Connect WhatsApp and wait for automatic sync.'
                : 'No destinations match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell className="w-12">On</TableHeaderCell>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell className="hidden lg:table-cell">Used by</TableHeaderCell>
                    <TableHeaderCell className="w-20">Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTargets.map((target) => {
                    const usedBy = targetUsageById.get(target.id) || [];
                    return (
                      <TableRow key={target.id}>
                        <TableCell>
                          <Checkbox
                            checked={target.active}
                            onCheckedChange={(checked) => updateActive(target, checked === true)}
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
                        <TableCell className="hidden max-w-[300px] text-xs lg:table-cell">
                          {usedBy.length ? (
                            <div className="space-y-1">
                              <Badge variant="success">{usedBy.length} schedule{usedBy.length !== 1 ? 's' : ''}</Badge>
                              <p className="truncate text-muted-foreground">{usedBy.map((schedule) => schedule.name).join(', ')}</p>
                            </div>
                          ) : target.type === 'status' ? (
                            <span className="text-muted-foreground">Status destination</span>
                          ) : target.active ? (
                            <span className="text-warning-foreground">Not selected in a running schedule</span>
                          ) : (
                            <span className="text-muted-foreground">Off</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
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
            <AlertDialogTitle>Delete Destination</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{deleteTarget?.name}&quot; from this app? This does not remove the real WhatsApp chat, group, or channel.
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
