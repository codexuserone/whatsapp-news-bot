import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Checkbox } from '../components/ui/checkbox';
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableHeaderCell
} from '../components/ui/table';
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

const TYPE_BADGES = {
  individual: { label: 'Individual', variant: 'secondary' },
  group: { label: 'Group', variant: 'success' },
  channel: { label: 'Channel', variant: 'default' },
  status: { label: 'Status', variant: 'warning' }
};

const TargetsPage = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [importing, setImporting] = useState(false);

  // Fetch existing targets
  const { data: targets = [], isLoading: targetsLoading } = useQuery({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  // Fetch WhatsApp status
  const { data: waStatus } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 5000
  });

  // Fetch WhatsApp groups (only when connected)
  const { data: waGroups = [], refetch: refetchGroups } = useQuery({
    queryKey: ['whatsapp-groups'],
    queryFn: () => api.get('/api/whatsapp/groups'),
    enabled: waStatus?.status === 'connected'
  });

  // Fetch WhatsApp channels (only when connected)
  const { data: waChannels = [], refetch: refetchChannels } = useQuery({
    queryKey: ['whatsapp-channels'],
    queryFn: () => api.get('/api/whatsapp/channels'),
    enabled: waStatus?.status === 'connected'
  });

  const isConnected = waStatus?.status === 'connected';
  const existingJids = new Set(targets.map((t) => t.phone_number));

  // Mutations
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

  // Import all groups at once
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

  // Import all channels at once
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

  // Add status broadcast
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

  // Filter targets
  const filteredTargets = targets.filter((t) => {
    const matchesSearch =
      !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.phone_number.toLowerCase().includes(search.toLowerCase());
    const matchesType = filterType === 'all' || t.type === filterType;
    return matchesSearch && matchesType;
  });

  // Count by type
  const counts = {
    all: targets.length,
    group: targets.filter((t) => t.type === 'group').length,
    channel: targets.filter((t) => t.type === 'channel').length,
    status: targets.filter((t) => t.type === 'status').length,
    individual: targets.filter((t) => t.type === 'individual').length
  };

  // Available to import
  const availableGroups = waGroups.filter((g) => !existingJids.has(g.jid));
  const availableChannels = waChannels.filter((c) => !existingJids.has(c.jid));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Targets"
        subtitle="Import WhatsApp groups and channels as message destinations."
      />

      {/* WhatsApp Connection Status */}
      {!isConnected && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-amber-100 p-2">
              <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <h3 className="font-medium text-amber-800">WhatsApp Not Connected</h3>
              <p className="text-sm text-amber-700 mt-1">
                Connect WhatsApp first to import groups and channels automatically.
              </p>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <a href="/whatsapp">Go to WhatsApp Console</a>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Import Section */}
      {isConnected && (
        <div className="grid gap-4 sm:grid-cols-3">
          {/* Import Groups */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Groups</p>
                  <p className="text-sm text-muted-foreground">
                    {availableGroups.length} available to import
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={importAllGroups}
                  disabled={importing || availableGroups.length === 0}
                >
                  {importing ? 'Importing...' : 'Import All'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Import Channels */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Channels</p>
                  <p className="text-sm text-muted-foreground">
                    {availableChannels.length} available to import
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={importAllChannels}
                  disabled={importing || availableChannels.length === 0}
                >
                  {importing ? 'Importing...' : 'Import All'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Status Broadcast */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Status Broadcast</p>
                  <p className="text-sm text-muted-foreground">Post to your WhatsApp Status</p>
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
            <CardTitle>Saved Targets ({targets.length})</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Input
                placeholder="Search targets..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48"
              />
              <div className="flex gap-1">
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
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {targetsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-foreground" />
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
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Active</TableHeaderCell>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>JID / Phone</TableHeaderCell>
                  <TableHeaderCell>Notes</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
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
                    <TableCell className="font-mono text-xs max-w-[200px] truncate">
                      {target.phone_number}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[150px] truncate">
                      {target.notes || '-'}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteTarget(target)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
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
