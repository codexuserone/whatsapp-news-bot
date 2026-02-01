import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Label } from '../components/ui/label';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';
import { CalendarClock, Play, Pencil, Trash2, Loader2 } from 'lucide-react';

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
    saveSchedule.mutate({
      name: values.name,
      cron_expression: values.cron_expression || null,
      timezone: values.timezone || 'UTC',
      feed_id: values.feed_id || null,
      target_ids: values.target_ids,
      template_id: values.template_id,
      active: values.active
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Schedules</h1>
        <p className="text-muted-foreground">Control delivery timing, intervals, and batch dispatch rules.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5" />
              {active ? 'Edit Schedule' : 'Create Schedule'}
            </CardTitle>
            <CardDescription>
              Configure when and where to send messages
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" {...form.register('name')} placeholder="Daily Morning Dispatch" />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="cron">Cron Expression (optional)</Label>
                  <Input id="cron" {...form.register('cron_expression')} placeholder="0 9 * * *" />
                  <p className="text-xs text-muted-foreground">Leave empty for immediate dispatch</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input id="timezone" {...form.register('timezone')} placeholder="UTC" />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="feed_id">Feed</Label>
                <Select id="feed_id" {...form.register('feed_id')}>
                  <option value="">Select feed</option>
                  {feeds.map((feed) => (
                    <option key={feed.id} value={feed.id}>
                      {feed.name}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Targets (Groups, Channels)</Label>
                <Controller
                  control={form.control}
                  name="target_ids"
                  render={({ field }) => (
                    <div className="rounded-lg border p-3 max-h-48 overflow-y-auto space-y-2">
                      {activeTargets.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No targets available. Add targets first.</p>
                      ) : (
                        activeTargets.map((target) => (
                          <label key={target.id} className="flex items-center gap-2 text-sm cursor-pointer">
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
                            <Badge variant="secondary" className="ml-auto">
                              {target.type}
                            </Badge>
                          </label>
                        ))
                      )}
                    </div>
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="template_id">Template</Label>
                <Select id="template_id" {...form.register('template_id')}>
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
                  <div className="flex items-center gap-2">
                    <Checkbox 
                      id="schedule_active"
                      checked={field.value} 
                      onChange={(e) => field.onChange(e.target.checked)} 
                    />
                    <Label htmlFor="schedule_active" className="cursor-pointer">Active</Label>
                  </div>
                )}
              />

              <div className="flex gap-2">
                <Button type="submit" disabled={saveSchedule.isPending}>
                  {saveSchedule.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {active ? 'Update Schedule' : 'Save Schedule'}
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

        {/* Saved Schedules */}
        <Card>
          <CardHeader>
            <CardTitle>Saved Schedules</CardTitle>
            <CardDescription>{schedules.length} schedule{schedules.length !== 1 ? 's' : ''}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {schedules.map((schedule) => (
                <div key={schedule.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{schedule.name}</p>
                      <p className="text-xs font-mono text-muted-foreground">
                        {schedule.cron_expression || 'Immediate'}
                      </p>
                    </div>
                    <Badge variant={schedule.active ? 'success' : 'secondary'}>
                      {schedule.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setActive(schedule)}>
                      <Pencil className="mr-1 h-3 w-3" /> Edit
                    </Button>
                    <Button 
                      size="sm" 
                      variant="outline"
                      onClick={() => dispatchSchedule.mutate(schedule.id)}
                      disabled={dispatchSchedule.isPending}
                    >
                      <Play className="mr-1 h-3 w-3" /> Dispatch
                    </Button>
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      onClick={() => deleteSchedule.mutate(schedule.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
              {schedules.length === 0 && (
                <p className="text-center text-muted-foreground py-8">
                  No schedules yet. Create one above.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default SchedulesPage;
