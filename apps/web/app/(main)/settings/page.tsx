'use client';

import React, { useEffect, useState } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ShabbosSettings, ShabbosStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Clock, MapPin, Loader2, Copy } from 'lucide-react';

const WHATSAPP_EDIT_MAX_MINUTES = 15;
const CORRECTION_SCAN_MAX_MINUTES = 120;

const schema = z.object({
  app_name: z.string().min(1),
  app_paused: z.boolean().default(false),
  default_timezone: z.string().min(1),
  log_retention_days: z.coerce.number().min(1),
  message_delay_ms: z.coerce.number().min(100),
  max_retries: z.coerce.number().min(0).max(25),
  defaultInterTargetDelaySec: z.coerce.number().min(0),
  defaultIntraTargetDelaySec: z.coerce.number().min(0),
  post_send_edit_window_minutes: z.coerce.number().min(1).max(WHATSAPP_EDIT_MAX_MINUTES),
  post_send_correction_window_minutes: z.coerce.number().min(1).max(CORRECTION_SCAN_MAX_MINUTES),
  processingTimeoutMinutes: z.coerce.number().min(1),
  dedupeThreshold: z.coerce.number().min(0).max(1).optional()
}).superRefine((value, ctx) => {
  if (value.post_send_correction_window_minutes < value.post_send_edit_window_minutes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['post_send_correction_window_minutes'],
      message: 'Correction window must be >= edit window'
    });
  }
});

type SettingsFormValues = z.infer<typeof schema>;

const PRESET_LOCATIONS = [
  { name: 'New York', latitude: 40.7128, longitude: -74.006, tzid: 'America/New_York' },
  { name: 'Los Angeles', latitude: 34.0522, longitude: -118.2437, tzid: 'America/Los_Angeles' },
  { name: 'Chicago', latitude: 41.8781, longitude: -87.6298, tzid: 'America/Chicago' },
  { name: 'Miami', latitude: 25.7617, longitude: -80.1918, tzid: 'America/New_York' },
  { name: 'Jerusalem', latitude: 31.7683, longitude: 35.2137, tzid: 'Asia/Jerusalem' },
  { name: 'London', latitude: 51.5074, longitude: -0.1278, tzid: 'Europe/London' },
  { name: 'Montreal', latitude: 45.5017, longitude: -73.5673, tzid: 'America/Montreal' },
  { name: 'Toronto', latitude: 43.6532, longitude: -79.3832, tzid: 'America/Toronto' }
];

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Europe/London',
  'Europe/Paris',
  'Asia/Jerusalem',
  'Asia/Dubai'
];

const SettingsPage = () => {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery<SettingsFormValues>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });
  const { data: shabbosStatus } = useQuery<ShabbosStatus>({
    queryKey: ['shabbos-status'],
    queryFn: () => api.get('/api/shabbos/status'),
    refetchInterval: 60000
  });
  const { data: shabbosSettings } = useQuery<ShabbosSettings>({
    queryKey: ['shabbos-settings'],
    queryFn: () => api.get('/api/shabbos/settings')
  });

  const [manualLocation, setManualLocation] = useState<string | null>(null);
  const selectedLocation = manualLocation ?? shabbosSettings?.city ?? '';

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      app_name: 'WhatsApp News Bot',
      app_paused: false,
      default_timezone: 'UTC',
      log_retention_days: 30,
      message_delay_ms: 2000,
      max_retries: 3,
      defaultInterTargetDelaySec: 8,
      defaultIntraTargetDelaySec: 3,
      post_send_edit_window_minutes: 15,
      post_send_correction_window_minutes: 120,
      processingTimeoutMinutes: 30,
      dedupeThreshold: 0.88
    }
  });
  const appPaused = useWatch({ control: form.control, name: 'app_paused' });

  useEffect(() => {
    if (settings) {
      form.reset(settings);
    }
  }, [settings, form]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hash) return;
    const id = hash.replace('#', '');
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const saveSettings = useMutation({
    mutationFn: (payload: SettingsFormValues) => api.put('/api/settings', payload),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data);
    }
  });

  const saveShabbosSettings = useMutation({
    mutationFn: (payload: Partial<ShabbosSettings>) => api.put('/api/shabbos/settings', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shabbos-settings'] });
      queryClient.invalidateQueries({ queryKey: ['shabbos-status'] });
    }
  });

  const handleLocationSelect = (locationName: string) => {
    const location = PRESET_LOCATIONS.find((l) => l.name === locationName);
    if (location) {
      setManualLocation(locationName);
      saveShabbosSettings.mutate({
        enabled: true,
        city: location.name,
        latitude: location.latitude,
        longitude: location.longitude,
        tzid: location.tzid,
        candleLightingMins: 18,
        havdalahMins: 50
      });
    }
  };

  const submitSettings = (values: SettingsFormValues) => {
    const editWindow = Math.max(
      1,
      Math.min(
        WHATSAPP_EDIT_MAX_MINUTES,
        Number(values.post_send_edit_window_minutes || WHATSAPP_EDIT_MAX_MINUTES)
      )
    );
    const correctionWindow = Math.max(
      editWindow,
      Math.min(
        CORRECTION_SCAN_MAX_MINUTES,
        Number(values.post_send_correction_window_minutes || CORRECTION_SCAN_MAX_MINUTES)
      )
    );

    saveSettings.mutate({
      ...values,
      post_send_edit_window_minutes: editWindow,
      post_send_correction_window_minutes: correctionWindow
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Configure global defaults and safety controls.</p>
      </div>

      <form onSubmit={form.handleSubmit(submitSettings)} className="space-y-6">
        <Card id="general">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              General
            </CardTitle>
            <CardDescription>Basic application settings</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3 sm:col-span-2 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Pause Entire App</p>
                  <p className="text-xs text-muted-foreground">
                    Stops automatic feed polling, queueing, and automation sends until resumed.
                  </p>
                </div>
                <Controller
                  control={form.control}
                  name="app_paused"
                  render={({ field }) => (
                    <Switch
                      checked={field.value === true}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                  )}
                />
              </div>
              {appPaused ? (
                <Badge variant="warning">App paused</Badge>
              ) : (
                <Badge variant="success">App running</Badge>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="default_timezone">Default Timezone</Label>
              <Controller
                control={form.control}
                name="default_timezone"
                render={({ field }) => {
                  const value = String(field.value || 'UTC');
                  const options = Array.from(new Set([value, ...COMMON_TIMEZONES]));
                  return (
                    <Select value={value} onValueChange={field.onChange}>
                      <SelectTrigger id="default_timezone">
                        <SelectValue placeholder="Select timezone" />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((timezone) => (
                          <SelectItem key={timezone} value={timezone}>
                            {timezone}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  );
                }}
              />
            </div>
          </CardContent>
        </Card>

        <Card id="messaging">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Messaging
            </CardTitle>
            <CardDescription>Core defaults for sending and history.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2" id="delays">
                <Label htmlFor="message_delay_ms">Gap Between Messages (ms)</Label>
                <Input id="message_delay_ms" type="number" {...form.register('message_delay_ms', { valueAsNumber: true })} />
                <p className="text-xs text-muted-foreground">Higher value = slower and safer sending.</p>
              </div>
              <div className="space-y-2" id="retention">
                <Label htmlFor="log_retention_days">Keep History (days)</Label>
                <Input id="log_retention_days" type="number" {...form.register('log_retention_days', { valueAsNumber: true })} />
                <p className="text-xs text-muted-foreground">How long sent/failed history stays visible.</p>
              </div>
            </div>

            <details className="rounded-lg border bg-muted/20 p-3">
              <summary className="cursor-pointer text-sm font-medium">Advanced delivery options</summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="max_retries">Max Retries</Label>
                  <Input id="max_retries" type="number" {...form.register('max_retries', { valueAsNumber: true })} />
                  <p className="text-xs text-muted-foreground">Retries before a message is marked failed.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="defaultInterTargetDelaySec">Gap Between Targets (sec)</Label>
                  <Input
                    id="defaultInterTargetDelaySec"
                    type="number"
                    {...form.register('defaultInterTargetDelaySec', { valueAsNumber: true })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="defaultIntraTargetDelaySec">Gap Within One Target (sec)</Label>
                  <Input
                    id="defaultIntraTargetDelaySec"
                    type="number"
                    {...form.register('defaultIntraTargetDelaySec', { valueAsNumber: true })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="processingTimeoutMinutes">Stuck Send Timeout (min)</Label>
                  <Input
                    id="processingTimeoutMinutes"
                    type="number"
                    {...form.register('processingTimeoutMinutes', { valueAsNumber: true })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="post_send_edit_window_minutes">In-place Edit Window (min)</Label>
                  <Input
                    id="post_send_edit_window_minutes"
                    type="number"
                    min={1}
                    max={WHATSAPP_EDIT_MAX_MINUTES}
                    {...form.register('post_send_edit_window_minutes', { valueAsNumber: true })}
                  />
                  <p className="text-xs text-muted-foreground">
                    True WhatsApp edit only. Max {WHATSAPP_EDIT_MAX_MINUTES} minutes (real WhatsApp limit). If you enter more, it is saved as {WHATSAPP_EDIT_MAX_MINUTES}.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="post_send_correction_window_minutes">Correction Scan Window (min)</Label>
                  <Input
                    id="post_send_correction_window_minutes"
                    type="number"
                    min={1}
                    max={CORRECTION_SCAN_MAX_MINUTES}
                    {...form.register('post_send_correction_window_minutes', { valueAsNumber: true })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Feed changes are monitored in this window (max {CORRECTION_SCAN_MAX_MINUTES} min). This does not bypass WhatsApp&rsquo;s {WHATSAPP_EDIT_MAX_MINUTES}-minute edit limit.
                  </p>
                </div>
              </div>
            </details>
          </CardContent>
        </Card>

        <Card id="dedupe">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Copy className="h-5 w-5" />
              Duplicate Filter
            </CardTitle>
            <CardDescription>Optional: block near-duplicate stories.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="dedupeThreshold">Similarity Threshold</Label>
              <Input
                id="dedupeThreshold"
                type="number"
                step="0.01"
                min="0"
                max="1"
                {...form.register('dedupeThreshold', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                Default 0.88. Lower catches more near-duplicates.
              </p>
            </div>
          </CardContent>
        </Card>

        <Button type="submit" disabled={saveSettings.isPending}>
          {saveSettings.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Settings
        </Button>
      </form>

      <Card id="shabbos">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                Shabbos Mode
              </CardTitle>
              <CardDescription>Auto-pause during Shabbos and Yom Tov</CardDescription>
            </div>
            {shabbosStatus?.isShabbos ? (
              <Badge variant="warning">Currently Shabbos</Badge>
            ) : (
              <Badge variant="success">Regular Mode</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {shabbosStatus && (
            <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Current Status</span>
                <span className="font-medium">{shabbosStatus.reason || 'Regular weekday'}</span>
              </div>
              {shabbosStatus.nextShabbos && (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Next Shabbos Starts</span>
                    <span>{new Date(shabbosStatus.nextShabbos.start).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Next Shabbos Ends</span>
                    <span>{new Date(shabbosStatus.nextShabbos.end).toLocaleString()}</span>
                  </div>
                </>
              )}
              {shabbosStatus.isShabbos && shabbosStatus.endsAt && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Resumes At</span>
                  <span className="font-semibold text-success">
                    {new Date(shabbosStatus.endsAt).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="space-y-3">
            <Label>Your Location</Label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {PRESET_LOCATIONS.map((location) => (
                <Button
                  key={location.name}
                  type="button"
                  variant={selectedLocation === location.name ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleLocationSelect(location.name)}
                  disabled={saveShabbosSettings.isPending}
                >
                  {location.name}
                </Button>
              ))}
            </div>
            {shabbosSettings?.city && (
              <p className="text-xs text-muted-foreground">
                Currently set to: {shabbosSettings.city} ({shabbosSettings.tzid})
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Candle Lighting (minutes before sunset)</Label>
              <Input
                type="number"
                value={shabbosSettings?.candleLightingMins || 18}
                onChange={(e) =>
                  saveShabbosSettings.mutate({
                    ...(shabbosSettings || {}),
                    candleLightingMins: parseInt(e.target.value, 10) || 18
                  })
                }
                min={0}
                max={60}
              />
            </div>
            <div className="space-y-2">
              <Label>Havdalah (minutes after sunset)</Label>
              <Input
                type="number"
                value={shabbosSettings?.havdalahMins || 50}
                onChange={(e) =>
                  saveShabbosSettings.mutate({
                    ...(shabbosSettings || {}),
                    havdalahMins: parseInt(e.target.value, 10) || 50
                  })
                }
                min={30}
                max={90}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Checkbox
              id="shabbos_enabled"
              checked={shabbosSettings?.enabled ?? true}
              onCheckedChange={(checked) =>
                saveShabbosSettings.mutate({
                  ...(shabbosSettings || {}),
                  enabled: checked === true
                })
              }
            />
            <Label htmlFor="shabbos_enabled" className="cursor-pointer">
              Enable Shabbos Mode (auto-pause during Shabbos/Yom Tov)
            </Label>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default SettingsPage;
