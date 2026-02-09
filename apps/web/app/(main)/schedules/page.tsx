'use client';

import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Feed, Schedule, Target, Template } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { CalendarClock, Play, Pencil, Trash2, Loader2 } from 'lucide-react';

const pad2 = (value: number) => String(value).padStart(2, '0');

const schema = z.object({
  name: z.string().min(1),
  timing_mode: z.enum(['on_new', 'scheduled']).default('on_new'),
  schedule_preset: z.enum(['every15', 'every30', 'hourly', 'daily', 'weekly']).default('daily'),
  time_of_day: z.string().default('09:00'),
  day_of_week: z.enum(['0', '1', '2', '3', '4', '5', '6']).default('1'),
  timezone: z.string().optional(),
  feed_id: z.string().min(1, 'Feed is required'),
  target_ids: z.array(z.string()).min(1),
  template_id: z.string().min(1)
});

type ScheduleFormValues = z.infer<typeof schema>;

type ScheduleApiPayload = {
  name: string;
  cron_expression?: string | null;
  timezone: string;
  feed_id: string;
  target_ids: string[];
  template_id: string;
  state: 'active' | 'paused' | 'stopped';
  active: boolean;
};

type DispatchResult = {
  sent?: number;
  queued?: number;
  skipped?: boolean;
  reason?: string;
  resumeAt?: string | null;
  error?: string | null;
};

type DispatchDiagnostics = {
  ok?: boolean;
  blockingReasons?: string[];
  warnings?: string[];
  logs?: { pending?: number; sent?: number; failed?: number };
  latestFeedItem?: { id?: string; title?: string; created_at?: string };
  whatsapp?: { status?: string; lastError?: string };
};

const getScheduleState = (schedule?: Schedule | null): 'active' | 'paused' | 'stopped' => {
  if (schedule?.state === 'active' || schedule?.state === 'paused' || schedule?.state === 'stopped') {
    return schedule.state;
  }
  return schedule?.active ? 'active' : 'stopped';
};

const isRunning = (schedule?: Schedule | null) => getScheduleState(schedule) === 'active';

const SchedulesPage = () => {
  const queryClient = useQueryClient();
  const { data: schedules = [] } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: () => api.get('/api/schedules'),
    refetchInterval: 5000
  });
  const { data: feeds = [] } = useQuery<Feed[]>({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const { data: targets = [] } = useQuery<Target[]>({ queryKey: ['targets'], queryFn: () => api.get('/api/targets') });
  const { data: templates = [] } = useQuery<Template[]>({ queryKey: ['templates'], queryFn: () => api.get('/api/templates') });
  const { data: settings } = useQuery<{ default_timezone?: string }>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings')
  });
  const [active, setActive] = useState<Schedule | null>(null);
  const activeTargets = targets.filter((target) => target.active);

  const formatDateTime = (value?: string | null) => {
    if (!value) return '-';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  };

  const localTimezone = React.useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  const defaultTimezone = settings?.default_timezone || localTimezone;

  const deriveTimingFromCron = React.useCallback((cronExpression?: string | null) => {
    const cron = String(cronExpression || '').trim();
    if (!cron) {
      return {
        timing_mode: 'on_new' as const,
        schedule_preset: 'daily' as const,
        time_of_day: '09:00',
        day_of_week: '1' as const
      };
    }

    if (cron === '*/15 * * * *') {
      return {
        timing_mode: 'scheduled' as const,
        schedule_preset: 'every15' as const,
        time_of_day: '09:00',
        day_of_week: '1' as const
      };
    }
    if (cron === '*/30 * * * *') {
      return {
        timing_mode: 'scheduled' as const,
        schedule_preset: 'every30' as const,
        time_of_day: '09:00',
        day_of_week: '1' as const
      };
    }
    if (cron === '0 * * * *') {
      return {
        timing_mode: 'scheduled' as const,
        schedule_preset: 'hourly' as const,
        time_of_day: '09:00',
        day_of_week: '1' as const
      };
    }

    const parts = cron.split(/\s+/);
    if (parts.length === 5) {
      const minute = Number(parts[0]);
      const hour = Number(parts[1]);
      const dom = parts[2];
      const month = parts[3];
      const dow = parts[4] || '';

      if (Number.isFinite(minute) && Number.isFinite(hour) && dom === '*' && month === '*') {
        const time_of_day = `${pad2(hour)}:${pad2(minute)}`;
        if (dow === '*') {
          return {
            timing_mode: 'scheduled' as const,
            schedule_preset: 'daily' as const,
            time_of_day,
            day_of_week: '1' as const
          };
        }
        if (/^[0-6]$/.test(dow)) {
          return {
            timing_mode: 'scheduled' as const,
            schedule_preset: 'weekly' as const,
            time_of_day,
            day_of_week: dow as '0' | '1' | '2' | '3' | '4' | '5' | '6'
          };
        }
      }
    }

    return {
      timing_mode: 'scheduled' as const,
      schedule_preset: 'daily' as const,
      time_of_day: '09:00',
      day_of_week: '1' as const
    };
  }, []);

  const describeSchedule = (schedule: Schedule) => {
    const mode = schedule.delivery_mode === 'batch' || schedule.delivery_mode === 'batched' ? 'batch' : 'immediate';
    const batchTimes = Array.isArray(schedule.batch_times) ? schedule.batch_times.filter(Boolean) : [];
    const cron = String(schedule.cron_expression || '').trim();
    const modeSuffix = mode === 'batch' ? (batchTimes.length ? ` (batch: ${batchTimes.join(', ')})` : ' (batch)') : '';
    if (!cron) return `On new items${modeSuffix}`;
    if (cron === '*/15 * * * *') return `Every 15 minutes${modeSuffix}`;
    if (cron === '*/30 * * * *') return `Every 30 minutes${modeSuffix}`;
    if (cron === '0 * * * *') return `Hourly${modeSuffix}`;

    const parts = cron.split(/\s+/);
    if (parts.length === 5) {
      const minute = Number(parts[0]);
      const hour = Number(parts[1]);
      const dom = parts[2];
      const month = parts[3];
      const dow = parts[4] || '';
      if (Number.isFinite(minute) && Number.isFinite(hour) && dom === '*' && month === '*') {
        const timeLabel = `${pad2(hour)}:${pad2(minute)}`;
        if (dow === '*') return `Daily at ${timeLabel}${modeSuffix}`;
        const days: Record<string, string> = {
          '0': 'Sunday',
          '1': 'Monday',
          '2': 'Tuesday',
          '3': 'Wednesday',
          '4': 'Thursday',
          '5': 'Friday',
          '6': 'Saturday'
        };
        const dayLabel = days[dow];
        if (dayLabel) return `Weekly on ${dayLabel} at ${timeLabel}${modeSuffix}`;
      }
    }
    return `Scheduled${modeSuffix}`;
  };

  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      timing_mode: 'on_new',
      schedule_preset: 'daily',
      time_of_day: '09:00',
      day_of_week: '1',
      timezone: defaultTimezone,
      feed_id: '',
      target_ids: [],
      template_id: ''
    }
  });

  const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error');

  useEffect(() => {
    if (active) {
      const timing = deriveTimingFromCron(active.cron_expression);
      form.reset({
        name: active.name,
        timing_mode: timing.timing_mode,
        schedule_preset: timing.schedule_preset,
        time_of_day: timing.time_of_day,
        day_of_week: timing.day_of_week,
        timezone: active.timezone || localTimezone,
        feed_id: active.feed_id || '',
        target_ids: (active.target_ids || []).map((id: string) => id.toString()),
        template_id: active.template_id || ''
      });
    }
  }, [active, form, localTimezone, deriveTimingFromCron]);

  useEffect(() => {
    if (active) return;
    const current = String(form.getValues('timezone') || '').trim();
    if (!current || current === localTimezone) {
      form.setValue('timezone', defaultTimezone);
    }
  }, [active, defaultTimezone, form, localTimezone]);

  const saveSchedule = useMutation({
    mutationFn: ({ scheduleId, payload }: { scheduleId: string | null; payload: ScheduleApiPayload }) =>
      scheduleId ? api.put<Schedule>(`/api/schedules/${scheduleId}`, payload) : api.post<Schedule>('/api/schedules', payload),
    onSuccess: (savedSchedule: Schedule) => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      setActive(savedSchedule);
    },
    onError: (error: unknown) => alert(`Failed to save schedule: ${getErrorMessage(error)}`)
  });

  const deleteSchedule = useMutation({
    mutationFn: (id: string) => api.delete(`/api/schedules/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      if (active?.id === id) {
        setActive(null);
        form.reset({
          name: '',
          timing_mode: 'on_new',
          schedule_preset: 'daily',
          time_of_day: '09:00',
          day_of_week: '1',
          timezone: defaultTimezone,
          feed_id: '',
          target_ids: [],
          template_id: ''
        });
      }
    },
    onError: (error: unknown) => alert(`Failed to delete schedule: ${getErrorMessage(error)}`)
  });

  const toSchedulePayload = (schedule: Schedule): ScheduleApiPayload | null => {
    if (!schedule.feed_id || !schedule.template_id || !Array.isArray(schedule.target_ids) || !schedule.target_ids.length) {
      return null;
    }

    const state = getScheduleState(schedule);
    return {
      name: schedule.name,
      cron_expression: schedule.cron_expression || null,
      timezone: schedule.timezone || defaultTimezone,
      feed_id: schedule.feed_id,
      target_ids: schedule.target_ids,
      template_id: schedule.template_id,
      state,
      active: state === 'active'
    };
  };

  const setScheduleState = useMutation({
    mutationFn: ({ schedule, state }: { schedule: Schedule; state: 'active' | 'paused' | 'stopped' }) => {
      const payload = toSchedulePayload(schedule);
      if (!payload) {
        throw new Error('Schedule is missing feed, template, or targets; open Edit and save once to normalize it.');
      }
      return api.put(`/api/schedules/${schedule.id}`, { ...payload, state, active: state === 'active' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error: unknown) => alert(`Failed to update automation state: ${getErrorMessage(error)}`)
  });

  const dispatchSchedule = useMutation({
    mutationFn: (id: string) => api.post<DispatchResult>(`/api/schedules/${id}/dispatch`),
    onSuccess: async (data: DispatchResult, scheduleId: string) => {
      queryClient.invalidateQueries({ queryKey: ['logs'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      let message;
      if ((data?.sent || 0) > 0) {
        const sentCount = data?.sent || 0;
        const queuedCount = data?.queued || 0;
        message = `Successfully sent ${sentCount} message${sentCount !== 1 ? 's' : ''}`;
        if (queuedCount > 0) {
          message += ` (queued ${queuedCount} more)`;
        }
      } else if ((data?.queued || 0) > 0) {
        const queuedCount = data?.queued || 0;
        message = `Queued ${queuedCount} message${queuedCount !== 1 ? 's' : ''}.`;
        if (data?.skipped && data?.reason) {
          message += ` ${data.reason}`;
        } else {
          message += ' Connect WhatsApp and dispatch again to send.';
        }
      } else if (data?.skipped && data?.reason) {
        message = `Skipped: ${data.reason}`;
      } else {
        try {
          const diagnostics = await api.get<DispatchDiagnostics>(`/api/schedules/${scheduleId}/diagnostics`);
          const blocking = diagnostics.blockingReasons || [];
          const warnings = diagnostics.warnings || [];
          message = 'No messages were sent.';
          if (blocking.length) {
            message += `\n\nBlocking reasons:\n- ${blocking.join('\n- ')}`;
          }
          if (warnings.length) {
            message += `\n\nWarnings:\n- ${warnings.join('\n- ')}`;
          }
          if (!blocking.length && !warnings.length) {
            message += '\n\nNo new items were queued since the last run.';
          }
        } catch {
          message = 'No messages were sent. No new items were queued.';
        }
      }
      alert(message);
    },
    onError: (error: unknown) => {
      alert(`Error: ${getErrorMessage(error) || 'Failed to dispatch schedule'}`);
    }
  });


  const onSubmit = (values: ScheduleFormValues) => {
    const tz = defaultTimezone;

    let cron_expression: string | null = null;
    if (values.timing_mode === 'scheduled') {
      if (values.schedule_preset === 'every15') {
        cron_expression = '*/15 * * * *';
      } else if (values.schedule_preset === 'every30') {
        cron_expression = '*/30 * * * *';
      } else if (values.schedule_preset === 'hourly') {
        cron_expression = '0 * * * *';
      } else {
        const [hhRaw, mmRaw] = String(values.time_of_day || '09:00').split(':');
        const hh = Number(hhRaw);
        const mm = Number(mmRaw);
        const hour = Number.isFinite(hh) ? hh : 9;
        const minute = Number.isFinite(mm) ? mm : 0;
        if (values.schedule_preset === 'weekly') {
          cron_expression = `${minute} ${hour} * * ${values.day_of_week}`;
        } else {
          cron_expression = `${minute} ${hour} * * *`;
        }
      }
    }

    const nextState: 'active' | 'paused' | 'stopped' = active ? getScheduleState(active) : 'active';

    const payload: ScheduleApiPayload = {
      name: values.name,
      cron_expression,
      timezone: tz,
      feed_id: values.feed_id,
      target_ids: values.target_ids,
      template_id: values.template_id,
      state: nextState,
      active: nextState === 'active'
    };
    saveSchedule.mutate({
      scheduleId: active?.id || null,
      payload
    });
  };

  const timingMode = form.watch('timing_mode');
  const schedulePreset = form.watch('schedule_preset');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Automations</h1>
          <p className="text-muted-foreground">Choose what to send, where to send it, and when it should run.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-sm">
            {schedules.length} Automation{schedules.length !== 1 ? 's' : ''}
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-2 border-dashed border-primary/20">
          <CardHeader className="bg-primary/5">
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-primary" />
              {active ? 'Edit Automation' : 'Create New Automation'}
            </CardTitle>
            <CardDescription>Set when this automation should send messages.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {Object.keys(form.formState.errors).length > 0 && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  <ul className="list-disc list-inside space-y-0.5">
                    {form.formState.errors.target_ids && <li>Select at least one target</li>}
                    {form.formState.errors.template_id && <li>Select a template</li>}
                    {form.formState.errors.name && <li>Name is required</li>}
                  </ul>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" {...form.register('name')} placeholder="Daily Morning Dispatch" />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="timing_mode">Send timing</Label>
                  <Controller
                    control={form.control}
                    name="timing_mode"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="timing_mode">
                          <SelectValue placeholder="Send timing" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="on_new">On new items</SelectItem>
                          <SelectItem value="scheduled">On a schedule</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <p className="text-xs text-muted-foreground">
                    {timingMode === 'scheduled'
                      ? 'Messages send on a simple schedule (no cron required).'
                      : 'Messages send automatically when new feed items are detected.'}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="schedule_preset">Schedule</Label>
                  <Controller
                    control={form.control}
                    name="schedule_preset"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={timingMode !== 'scheduled'}
                      >
                        <SelectTrigger id="schedule_preset">
                          <SelectValue placeholder="Schedule" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="every15">Every 15 minutes</SelectItem>
                          <SelectItem value="every30">Every 30 minutes</SelectItem>
                          <SelectItem value="hourly">Every hour</SelectItem>
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              </div>

              {timingMode === 'scheduled' && (schedulePreset === 'daily' || schedulePreset === 'weekly') && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="time_of_day">Time</Label>
                    <Input id="time_of_day" type="time" {...form.register('time_of_day')} />
                    <p className="text-xs text-muted-foreground">Timezone: {defaultTimezone}</p>
                  </div>
                  {schedulePreset === 'weekly' ? (
                    <div className="space-y-2">
                      <Label htmlFor="day_of_week">Day</Label>
                      <Controller
                        control={form.control}
                        name="day_of_week"
                        render={({ field }) => (
                          <Select value={field.value} onValueChange={field.onChange}>
                            <SelectTrigger id="day_of_week">
                              <SelectValue placeholder="Day of week" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="0">Sunday</SelectItem>
                              <SelectItem value="1">Monday</SelectItem>
                              <SelectItem value="2">Tuesday</SelectItem>
                              <SelectItem value="3">Wednesday</SelectItem>
                              <SelectItem value="4">Thursday</SelectItem>
                              <SelectItem value="5">Friday</SelectItem>
                              <SelectItem value="6">Saturday</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label>Day</Label>
                      <div className="h-10 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                        Every day
                      </div>
                    </div>
                  )}
                </div>
              )}

              <p className="text-xs text-muted-foreground">First run sends the latest item. Future runs catch up on new items automatically.</p>

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
                        <SelectTrigger
                          id="feed_id"
                          className={value === '__none' ? 'text-muted-foreground' : undefined}
                        >
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
                  render={({ field }) => {
                    const all = activeTargets;
                    const groups = all.filter(t => t.type === 'group');
                    const channels = all.filter(t => t.type === 'channel');
                    const others = all.filter(t => t.type !== 'group' && t.type !== 'channel');

                    const renderGroup = (title: string, items: Target[]) => {
                      if (!items.length) return null;
                      return (
                        <div className="space-y-1">
                          <p className="text-xs font-semibold text-muted-foreground px-2 pt-1">{title}</p>
                          {items.map(target => (
                            <label key={target.id} className="flex items-center gap-2 text-sm cursor-pointer px-2 py-1 rounded hover:bg-muted/50">
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
                              {target.type === 'status' && <Badge variant="warning" className="ml-auto text-[10px] h-5">Status</Badge>}
                            </label>
                          ))}
                        </div>
                      );
                    };

                    return (
                      <div className="rounded-lg border p-2 max-h-60 overflow-y-auto space-y-3">
                        {all.length === 0 ? (
                          <p className="text-sm text-muted-foreground p-2">No active targets found.</p>
                        ) : (
                          <>
                            {renderGroup('Channels', channels)}
                            {renderGroup('Groups', groups)}
                            {renderGroup('Other', others)}
                          </>
                        )}
                      </div>
                    );
                  }}
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
                        <SelectTrigger
                          id="template_id"
                          className={value === '__none' ? 'text-muted-foreground' : undefined}
                        >
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

        <Card>
          <CardHeader>
            <CardTitle>Your Automations</CardTitle>
            <CardDescription>Use &quot;Send once&quot; for an immediate one-time send, or let automations run on their own.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {schedules.map((schedule) => (
                <div key={schedule.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{schedule.name}</p>
                      <p className="text-xs text-muted-foreground">{describeSchedule(schedule)}</p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {schedule.cron_expression ? (
                          <span>Next: {formatDateTime(schedule.next_run_at)}</span>
                        ) : (
                          <span>Runs on new items</span>
                        )}
                        <span>Last: {formatDateTime(schedule.last_run_at)}</span>
                      </div>
                    </div>
                    <Badge variant={isRunning(schedule) ? 'success' : 'secondary'}>
                      {getScheduleState(schedule) === 'active'
                        ? 'Running'
                        : getScheduleState(schedule) === 'paused'
                          ? 'Paused'
                          : 'Stopped'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setActive(schedule)}>
                      <Pencil className="mr-1 h-3 w-3" /> Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => dispatchSchedule.mutate(schedule.id)} disabled={dispatchSchedule.isPending}>
                      <Play className="mr-1 h-3 w-3" /> Send once
                    </Button>
                    {getScheduleState(schedule) !== 'active' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setScheduleState.mutate({ schedule, state: 'active' })}
                        disabled={setScheduleState.isPending || !toSchedulePayload(schedule)}
                      >
                        Start
                      </Button>
                    ) : null}
                    {getScheduleState(schedule) === 'active' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setScheduleState.mutate({ schedule, state: 'paused' })}
                        disabled={setScheduleState.isPending || !toSchedulePayload(schedule)}
                      >
                        Pause
                      </Button>
                    ) : null}
                    {getScheduleState(schedule) !== 'stopped' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setScheduleState.mutate({ schedule, state: 'stopped' })}
                        disabled={setScheduleState.isPending || !toSchedulePayload(schedule)}
                      >
                        Stop
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => deleteSchedule.mutate(schedule.id)} className="text-destructive hover:text-destructive">
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
