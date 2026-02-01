import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Checkbox } from '../components/ui/checkbox';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../components/ui/alert-dialog';
import { Target, Users, Radio, MessageSquare, Download, Trash2, AlertTriangle, Loader2 } from 'lucide-react';

const TYPE_BADGES = {
  individual: { label: 'Individual', variant: 'secondary', icon: MessageSquare },
  group: { label: 'Group', variant: 'success', icon: Users },
  channel: { label: 'Channel', variant: 'default', icon: Radio },
  status: { label: 'Status', variant: 'warning', icon: Radio }
};

const TargetsPage = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [importing, setImporting] = useState(false);

  const { data: targets = [], isLoading: targetsLoading } = useQuery({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const { data: waStatus } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 5000
  });

  const { data: waGroups = [] } = useQuery({
    queryKey: ['whatsapp-groups'],
    queryFn: () => api.get('/api/whatsapp/groups'),
    enabled: waStatus?.status === 'connected'
  });

  const { data: waChannels = [] } = useQuery({
    queryKey: ['whatsapp-channels'],
    queryFn: () => api.get('/api/whatsapp/channels'),
    enabled: waStatus?.status === 'connected'
  });

  const isConnected = waStatus?.status === 'connected';
  const existingJids = new Set(targets.map((t) => t.phone_number));

  const addTarget = useMutation({
    mutationFn: (payload) => api.post('/api/targets', payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['targets'] })
  });

  const updateTarget = useMutation({
    mutationFn: ({ id, ...payload }) => api.put(`/api/targets/${id}`, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['targets'] })
  });

  const removeTarget = useMutation({
    mutationFn: (id) => api.delete(`/api/targets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      setDeleteTarget(null);
    }
  });

  const importAllGroups = async () => {
    setImporting(true);
    const newGroups = waGroups.filter((g) => !existingJids.has(g.jid));
    for (const group of newGroups) {
      await addTarget.mutateAsync({
        name: group.name,
        phone_number: group.jid,
        type: 'group',
        active: true,
        notes: `${group.size} members`
      });
    }
    setImporting(false);
  };

  const importAllChannels = async () => {
    setImporting(true);
    const newChannels = waChannels.filter((c) => !existingJids.has(c.jid));
    for (const channel of newChannels) {
      await addTarget.mutateAsync({
        name: channel.name,
        phone_number: channel.jid,
        type: 'channel',
        active: true,
        notes: `${channel.subscribers} subscribers`
      });
    }
    setImporting(false);
  };

  const addStatusBroadcast = () => {
    if (!existingJids.has('status@broadcast')) {
      addTarget.mutate({
        name: 'My Status',
        phone_number: 'status@broadcast',
        type: 'status',
        active: true,
        notes: 'Posts to your WhatsApp Status'
      });
    }
  };

  const filteredTargets = targets.filter((t) => {
    const matchesSearch =
      !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.phone_number.toLowerCase().includes(search.toLowerCase());
    const matchesType = filterType === 'all' || t.type === filterType;
    return matchesSearch && matchesType;
  });

  const counts = {
    all: targets.length,
    group: targets.filter((t) => t.type === 'group').length,
    channel: targets.filter((t) => t.type === 'channel').length,
    status: targets.filter((t) => t.type === 'status').length,
    individual: targets.filter((t) => t.type === 'individual').length
  };

  const availableGroups = waGroups.filter((g) => !existingJids.has(g.jid));
  const availableChannels = waChannels.filter((c) => !existingJids.has(c.jid));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Targets</h1>
        <p className="text-muted-foreground">Import WhatsApp groups and channels as message destinations.</p>
      </div>

      {/* Connection Warning */}
      {!isConnected && (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="flex items-start gap-4 pt-6">
            <div className="rounded-full bg-warning/20 p-2">
              <AlertTriangle className="h-5 w-5 text-warning-foreground" />
            </div>
            <div className="flex-1">
              <h3 className="font-medium">WhatsApp Not Connected</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Connect WhatsApp first to import groups and channels automatically.
              </p>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <Link to="/whatsapp">Go to WhatsApp Console</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Import */}
      {isConnected && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-primary/10 p-2">
                    <Users className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium">Groups</p>
                    <p className="text-sm text-muted-foreground">
                      {availableGroups.length} to import
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={importAllGroups}
                  disabled={importing || availableGroups.length === 0}
                >
                  {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-primary/10 p-2">
                    <Radio className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium">Channels</p>
                    <p className="text-sm text-muted-foreground">
                      {availableChannels.length} to import
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={importAllChannels}
                  disabled={importing || availableChannels.length === 0}
                >
                  {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-primary/10 p-2">
                    <Radio className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium">Status</p>
                    <p className="text-sm text-muted-foreground">Broadcast to contacts</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addStatusBroadcast}
                  disabled={existingJids.has('status@broadcast')}
                >
                  {existingJids.has('status@broadcast') ? 'Added' : 'Add'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Targets List */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Target className="h-5 w-5" />
                Saved Targets
              </CardTitle>
              <CardDescription>{targets.length} target{targets.length !== 1 ? 's' : ''} configured</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                placeholder="Search targets..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-1 pt-2">
            {['all', 'group', 'channel', 'status'].map((type) => (
              <Button
                key={type}
                size="sm"
                variant={filterType === type ? 'default' : 'outline'}
                onClick={() => setFilterType(type)}
              >
                {type === 'all' ? 'All' : TYPE_BADGES[type]?.label || type}
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
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {targets.length === 0
                  ? 'No targets yet. Import groups from WhatsApp above.'
                  : 'No targets match your search.'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className="w-12">Active</TableHeaderCell>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell className="hidden md:table-cell">JID / Phone</TableHeaderCell>
                  <TableHeaderCell className="hidden lg:table-cell">Notes</TableHeaderCell>
                  <TableHeaderCell className="w-20">Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTargets.map((target) => (
                  <TableRow key={target.id}>
                    <TableCell>
                      <Checkbox
                        checked={target.active}
                        onChange={(e) =>
                          updateTarget.mutate({ id: target.id, active: e.target.checked })
                        }
                      />
                    </TableCell>
                    <TableCell className="font-medium">{target.name}</TableCell>
                    <TableCell>
                      <Badge variant={TYPE_BADGES[target.type]?.variant || 'secondary'}>
                        {TYPE_BADGES[target.type]?.label || target.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground max-w-[200px] truncate md:table-cell">
                      {target.phone_number}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground max-w-[150px] truncate lg:table-cell">
                      {target.notes || '-'}
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

      {/* Delete Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Target</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeTarget.mutate(deleteTarget.id)}
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
