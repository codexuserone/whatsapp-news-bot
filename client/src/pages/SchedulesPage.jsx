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
  const enabledTargets = targets.filter((target) => target.enabled);

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      mode: 'immediate',
      intervalMinutes: 30,
      times: '',
      timezone: 'UTC',
      feedIds: [],
      targetIds: [],
      templateId: '',
      enabled: true
    }
  });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        mode: active.mode,
        intervalMinutes: active.intervalMinutes || 30,
        times: (active.times || []).join(', '),
        timezone: active.timezone || 'UTC',
        feedIds: (active.feedIds || []).map((id) => id.toString()),
        targetIds: (active.targetIds || []).map((id) => id.toString()),
        templateId: active.templateId ? active.templateId.toString() : '',
        enabled: active.enabled ?? true
      });
    }
  }, [active, form]);

  const saveSchedule = useMutation({
    mutationFn: (payload) =>
      active ? api.put(`/api/schedules/${active._id}`, payload) : api.post('/api/schedules', payload),
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
      mode: values.mode,
      intervalMinutes: values.mode === 'interval' ? values.intervalMinutes : undefined,
      times: values.mode === 'times' && values.times
        ? values.times.split(',').map((time) => time.trim()).filter(Boolean)
        : [],
      timezone: values.timezone || 'UTC',
      feedIds: values.feedIds,
      targetIds: values.targetIds,
      templateId: values.templateId,
      enabled: values.enabled
    };
    saveSchedule.mutate(payload);
  };

  const mode = form.watch('mode');

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
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <Input {...form.register('name')} placeholder="Daily Morning Dispatch" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Mode</label>
                  <Select {...form.register('mode')}>
                    <option value="immediate">Immediate</option>
                    <option value="interval">Interval</option>
                    <option value="times">Set Times</option>
                  </Select>
                </div>
              </div>

              {mode === 'interval' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Interval Minutes</label>
                  <Input type="number" {...form.register('intervalMinutes', { valueAsNumber: true })} />
                </div>
              )}

              {mode === 'times' && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Times (comma separated HH:mm)</label>
                  <Input {...form.register('times')} placeholder="09:00, 17:00" />
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">Timezone</label>
                <Input {...form.register('timezone')} placeholder="UTC" />
              </div>

              <div className="rounded-2xl border border-ink/10 bg-surface p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Feeds</p>
                <Controller
                  control={form.control}
                  name="feedIds"
                  render={({ field }) => (
                    <div className="mt-3 space-y-2">
                      {feeds.map((feed) => (
                        <label key={feed._id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={field.value.includes(feed._id)}
                            onChange={(event) => {
                              const next = new Set(field.value);
                              if (event.target.checked) {
                                next.add(feed._id);
                              } else {
                                next.delete(feed._id);
                              }
                              field.onChange(Array.from(next));
                            }}
                          />
                          {feed.name}
                        </label>
                      ))}
                    </div>
                  )}
                />
              </div>

              <div className="rounded-2xl border border-ink/10 bg-surface p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Targets (Groups, Channels, Status)</p>
                <Controller
                  control={form.control}
                  name="targetIds"
                  render={({ field }) => (
                    <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
                      {enabledTargets.length === 0 && (
                        <p className="text-sm text-ink/50">No targets available. Add targets first.</p>
                      )}
                      {enabledTargets.map((target) => (
                        <label key={target._id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={field.value.includes(target._id)}
                            onChange={(event) => {
                              const next = new Set(field.value);
                              if (event.target.checked) {
                                next.add(target._id);
                              } else {
                                next.delete(target._id);
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
                <Select {...form.register('templateId')}>
                  <option value="">Select template</option>
                  {templates.map((template) => (
                    <option key={template._id} value={template._id}>
                      {template.name}
                    </option>
                  ))}
                </Select>
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
                  <TableHeaderCell>Mode</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {schedules.map((schedule) => (
                  <TableRow key={schedule._id}>
                    <TableCell>{schedule.name}</TableCell>
                    <TableCell className="capitalize">{schedule.mode}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setActive(schedule)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => dispatchSchedule.mutate(schedule._id)}>
                          Dispatch Now
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteSchedule.mutate(schedule._id)}>
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
