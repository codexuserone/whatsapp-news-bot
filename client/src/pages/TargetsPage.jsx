import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';

const schema = z.object({
  name: z.string().min(1),
  type: z.enum(['group', 'channel', 'status']),
  jid: z.string().min(1),
  intraDelaySec: z.coerce.number().min(1).optional(),
  enabled: z.boolean().default(true)
});

const TYPE_LABELS = {
  group: 'Group',
  channel: 'Channel',
  status: 'Status'
};

const TYPE_COLORS = {
  group: 'success',
  channel: 'warning',
  status: 'secondary'
};

const TargetsPage = () => {
  const queryClient = useQueryClient();
  const { data: targets = [] } = useQuery({ queryKey: ['targets'], queryFn: () => api.get('/api/targets') });
  const [active, setActive] = useState(null);
  const [filterType, setFilterType] = useState('all');

  const filteredTargets = filterType === 'all' ? targets : targets.filter((t) => t.type === filterType);

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: '', type: 'group', jid: '', intraDelaySec: 3, enabled: true }
  });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        type: active.type,
        jid: active.jid,
        intraDelaySec: active.intraDelaySec || 3,
        enabled: active.enabled ?? true
      });
    }
  }, [active, form]);

  const saveTarget = useMutation({
    mutationFn: (payload) =>
      active ? api.put(`/api/targets/${active._id}`, payload) : api.post('/api/targets', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      setActive(null);
      form.reset();
    }
  });

  const deleteTarget = useMutation({
    mutationFn: (id) => api.delete(`/api/targets/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['targets'] })
  });

  const onSubmit = (values) => {
    saveTarget.mutate({
      name: values.name,
      type: values.type,
      jid: values.jid,
      intraDelaySec: values.intraDelaySec,
      enabled: values.enabled
    });
  };

  const groupCount = targets.filter((t) => t.type === 'group').length;
  const channelCount = targets.filter((t) => t.type === 'channel').length;
  const statusCount = targets.filter((t) => t.type === 'status').length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Targets"
        subtitle="Manage WhatsApp groups, channels, and status as message destinations."
      />

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="cursor-pointer hover:border-ink/30" onClick={() => setFilterType('group')}>
          <CardContent className="p-4">
            <p className="text-2xl font-bold">{groupCount}</p>
            <p className="text-sm text-ink/60">Groups</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:border-ink/30" onClick={() => setFilterType('channel')}>
          <CardContent className="p-4">
            <p className="text-2xl font-bold">{channelCount}</p>
            <p className="text-sm text-ink/60">Channels</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:border-ink/30" onClick={() => setFilterType('status')}>
          <CardContent className="p-4">
            <p className="text-2xl font-bold">{statusCount}</p>
            <p className="text-sm text-ink/60">Status</p>
          </CardContent>
        </Card>
      </div>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{active ? 'Edit Target' : 'Create Target'}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <Input {...form.register('name')} placeholder="Anash News Group" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Type</label>
                  <Select {...form.register('type')}>
                    <option value="group">Group</option>
                    <option value="channel">Channel</option>
                    <option value="status">Status</option>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">JID</label>
                  <Input {...form.register('jid')} placeholder="1203630...@g.us or status@broadcast" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Intra-message Delay (sec)</label>
                  <Input type="number" {...form.register('intraDelaySec', { valueAsNumber: true })} />
                </div>
              </div>
              <Controller
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
                    Enabled
                  </label>
                )}
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={saveTarget.isPending}>
                  {saveTarget.isPending ? 'Saving...' : active ? 'Update Target' : 'Save Target'}
                </Button>
                {active && (
                  <Button type="button" variant="outline" onClick={() => { setActive(null); form.reset(); }}>
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Targets ({filteredTargets.length})</CardTitle>
            <Select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="w-auto">
              <option value="all">All Types</option>
              <option value="group">Groups</option>
              <option value="channel">Channels</option>
              <option value="status">Status</option>
            </Select>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredTargets.map((target) => (
                  <TableRow key={target._id}>
                    <TableCell className="font-medium">{target.name}</TableCell>
                    <TableCell>
                      <Badge variant={TYPE_COLORS[target.type]}>{TYPE_LABELS[target.type]}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={target.enabled ? 'success' : 'secondary'}>
                        {target.enabled ? 'Active' : 'Disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setActive(target)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteTarget.mutate(target._id)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredTargets.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-ink/50">
                      No targets found. Import from WhatsApp Console or create manually.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <div className="rounded-2xl border border-ink/10 bg-surface p-4 text-sm text-ink/60">
        <strong>Tip:</strong> Import targets directly from the{' '}
        <a href="/whatsapp" className="text-brand underline">WhatsApp Console</a> for easier setup.
      </div>
    </div>
  );
};

export default TargetsPage;
