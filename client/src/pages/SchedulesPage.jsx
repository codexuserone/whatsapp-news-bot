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
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';

const schema = z.object({
  name: z.string().min(1),
  cron_expression: z.string().optional(),
  timezone: z.string().optional(),
  feed_id: z.string().optional(),
  target_ids: z.array(z.string()).min(1),
  template_id: z.string().min(1),
  active: z.boolean().default(true)
});

const SchedulesPage = () => {
  const queryClient = useQueryClient();
  const { data: schedules = [] } = useQuery({ queryKey: ['schedules'], queryFn: () => api.get('/api/schedules') });
  const { data: feeds = [] } = useQuery({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const { data: targets = [] } = useQuery({ queryKey: ['targets'], queryFn: () => api.get('/api/targets') });
  const { data: templates = [] } = useQuery({ queryKey: ['templates'], queryFn: () => api.get('/api/templates') });
  const [active, setActive] = useState(null);
  const activeTargets = targets.filter((target) => target.active);

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      cron_expression: '',
      timezone: 'UTC',
      feed_id: '',
      target_ids: [],
      template_id: '',
      active: true
    }
  });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        cron_expression: active.cron_expression || '',
        timezone: active.timezone || 'UTC',
        feed_id: active.feed_id || '',
        target_ids: (active.target_ids || []).map((id) => id.toString()),
        template_id: active.template_id || '',
        active: active.active ?? true
      });
    }
  }, [active, form]);

  const saveSchedule = useMutation({
    mutationFn: (payload) =>
      active ? api.put(`/api/schedules/${active.id}`, payload) : api.post('/api/schedules', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      setActive(null);
      form.reset();
    }
  });

  const deleteSchedule = useMutation({
    mutationFn: (id) => api.delete(`/api/schedules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedules'] })
  });

  const dispatchSchedule = useMutation({
    mutationFn: (id) => api.post(`/api/schedules/${id}/dispatch`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['logs'] })
  });

  const onSubmit = (values) => {
    const payload = {
      name: values.name,
      cron_expression: values.cron_expression || null,
      timezone: values.timezone || 'UTC',
      feed_id: values.feed_id || null,
      target_ids: values.target_ids,
      template_id: values.template_id,
      active: values.active
    };
    saveSchedule.mutate(payload);
  };

  return (
    <div className="space-y-8">
      <PageHeader title="Schedules" subtitle="Control delivery timing, intervals, and batch dispatch rules." />

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{active ? 'Edit Schedule' : 'Create Schedule'}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Name</label>
                <Input {...form.register('name')} placeholder="Daily Morning Dispatch" />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Cron Expression (optional)</label>
                  <Input {...form.register('cron_expression')} placeholder="0 9 * * * (9am daily)" />
                  <p className="text-xs text-ink/50">Leave empty for immediate dispatch on new items</p>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Timezone</label>
                  <Input {...form.register('timezone')} placeholder="UTC" />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Feed</label>
                <Select {...form.register('feed_id')}>
                  <option value="">Select feed</option>
                  {feeds.map((feed) => (
                    <option key={feed.id} value={feed.id}>
                      {feed.name}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="rounded-2xl border border-ink/10 bg-surface p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Targets (Groups, Channels)</p>
                <Controller
                  control={form.control}
                  name="target_ids"
                  render={({ field }) => (
                    <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
                      {activeTargets.length === 0 && (
                        <p className="text-sm text-ink/50">No targets available. Add targets first.</p>
                      )}
                      {activeTargets.map((target) => (
                        <label key={target.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={field.value.includes(target.id)}
                            onChange={(event) => {
                              const next = new Set(field.value);
                              if (event.target.checked) {
                                next.add(target.id);
                              } else {
                                next.delete(target.id);
                              }
                              field.onChange(Array.from(next));
                            }}
                          />
                          <span>{target.name}</span>
                          <span className="text-xs text-ink/40 capitalize">({target.type})</span>
                        </label>
                      ))}
                    </div>
                  )}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Template</label>
                <Select {...form.register('template_id')}>
                  <option value="">Select template</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </Select>
              </div>

              <Controller
                control={form.control}
                name="active"
                render={({ field }) => (
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
                    Active
                  </label>
                )}
              />

              <div className="flex gap-2">
                <Button type="submit" disabled={saveSchedule.isPending}>
                  {active ? 'Update Schedule' : 'Save Schedule'}
                </Button>
                {active && (
                  <Button type="button" variant="outline" onClick={() => setActive(null)}>
                    Clear
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Existing Schedules</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Cron</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {schedules.map((schedule) => (
                  <TableRow key={schedule.id}>
                    <TableCell>{schedule.name}</TableCell>
                    <TableCell className="font-mono text-xs">{schedule.cron_expression || 'Immediate'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setActive(schedule)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => dispatchSchedule.mutate(schedule.id)}>
                          Dispatch Now
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteSchedule.mutate(schedule.id)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {schedules.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-ink/50">
                      No schedules yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  );
};

export default SchedulesPage;
