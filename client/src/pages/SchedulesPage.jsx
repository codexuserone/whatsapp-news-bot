import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
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
  feed_id: z.string().min(1, 'Feed is required'),
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
    },
    onError: (error) => alert(`Failed to save schedule: ${error?.message || 'Unknown error'}`)
  });

  const deleteSchedule = useMutation({
    mutationFn: (id) => api.delete(`/api/schedules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (error) => alert(`Failed to delete schedule: ${error?.message || 'Unknown error'}`)
  });

  const dispatchSchedule = useMutation({
    mutationFn: (id) => api.post(`/api/schedules/${id}/dispatch`),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['logs'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      let message;
      if (data?.sent > 0) {
        message = `Successfully sent ${data.sent} message${data.sent !== 1 ? 's' : ''}`;
      } else if (data?.skipped && data?.reason) {
        message = `Skipped: ${data.reason}`;
      } else {
        message = 'No messages were sent. Refresh the feed first to queue items, then dispatch.';
      }
      alert(message);
    },
    onError: (error) => {
      alert(`Error: ${error?.message || 'Failed to dispatch schedule'}`);
    }
  });

  const onSubmit = (values) => {
    saveSchedule.mutate({
      name: values.name,
      cron_expression: values.cron_expression || null,
      timezone: values.timezone || 'UTC',
      feed_id: values.feed_id,
      target_ids: values.target_ids,
      template_id: values.template_id,
      active: values.active
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Automations</h1>
          <p className="text-muted-foreground">Create automated schedules to send feed content to your WhatsApp targets.</p>
        </div>
        <Badge variant="outline" className="text-sm">
          {schedules.length} Automation{schedules.length !== 1 ? 's' : ''}
        </Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-2 border-dashed border-primary/20">
          <CardHeader className="bg-primary/5">
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-primary" />
              {active ? 'Edit Automation' : 'Create New Automation'}
            </CardTitle>
            <CardDescription>
              Set up an automation to send messages on a schedule or immediately
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {Object.keys(form.formState.errors).length > 0 && (
                <div className="rounded-lg border-2 border-destructive bg-destructive/10 p-4 text-sm text-destructive">
                  <p className="font-semibold mb-2 text-base">Please complete all required fields:</p>
                  <ul className="list-disc list-inside space-y-1">
                    {form.formState.errors.name && <li>Name is required</li>}
                    {form.formState.errors.feed_id && <li>Select a feed from the dropdown</li>}
                    {form.formState.errors.target_ids && <li>Select at least one target (WhatsApp group/channel)</li>}
                    {form.formState.errors.template_id && <li>Select a message template</li>}
                  </ul>
                </div>
              )}
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
                <Controller
                  control={form.control}
                  name="feed_id"
                  render={({ field }) => {
                    const value = field.value || '__none';
                    return (
                      <Select
                        value={value}
                        onValueChange={(next) => field.onChange(next === '__none' ? '' : next)}
                      >
                        <SelectTrigger id="feed_id">
                          <SelectValue placeholder="Select feed" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none" className="text-muted-foreground">
                            Select feed
                          </SelectItem>
                          {feeds.map((feed) => (
                            <SelectItem key={feed.id} value={feed.id}>
                              {feed.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    );
                  }}
                />
                {form.formState.errors.feed_id && (
                  <p className="text-xs text-destructive">{form.formState.errors.feed_id.message}</p>
                )}
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
                              onCheckedChange={(checked) => {
                                const next = new Set(field.value);
                                if (checked === true) {
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
                <Controller
                  control={form.control}
                  name="template_id"
                  render={({ field }) => {
                    const value = field.value || '__none';
                    return (
                      <Select
                        value={value}
                        onValueChange={(next) => field.onChange(next === '__none' ? '' : next)}
                      >
                        <SelectTrigger id="template_id">
                          <SelectValue placeholder="Select template" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none" className="text-muted-foreground">
                            Select template
                          </SelectItem>
                          {templates.map((template) => (
                            <SelectItem key={template.id} value={template.id}>
                              {template.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    );
                  }}
                />
              </div>

              <Controller
                control={form.control}
                name="active"
                render={({ field }) => (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="schedule_active"
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                    <Label htmlFor="schedule_active" className="cursor-pointer">Active</Label>
                  </div>
                )}
              />

              <div className="flex gap-2">
                <Button type="submit" disabled={saveSchedule.isPending} size="lg">
                  {saveSchedule.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {active ? 'Update Automation' : 'Create Automation'}
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

        {/* Saved Automations */}
        <Card>
          <CardHeader>
            <CardTitle>Your Automations</CardTitle>
            <CardDescription>Click "Dispatch" to run immediately, or let scheduled automations run automatically.</CardDescription>
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
                <div className="text-center py-12 px-4">
                  <CalendarClock className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
                  <h3 className="font-medium text-lg mb-1">No automations yet</h3>
                  <p className="text-muted-foreground text-sm">
                    Create your first automation using the form on the left to start sending messages automatically.
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default SchedulesPage;
