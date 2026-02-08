'use client';

import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ShabbosSettings, ShabbosStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Clock, MapPin, Loader2, Copy } from 'lucide-react';

const schema = z.object({
  app_name: z.string().min(1),
  default_timezone: z.string().min(1),
  log_retention_days: z.coerce.number().min(1),
  message_delay_ms: z.coerce.number().min(100),
  max_retries: z.coerce.number().min(0).max(25),
  defaultInterTargetDelaySec: z.coerce.number().min(0),
  defaultIntraTargetDelaySec: z.coerce.number().min(0),
  processingTimeoutMinutes: z.coerce.number().min(1),
  dedupeThreshold: z.coerce.number().min(0).max(1).optional()
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
      default_timezone: 'UTC',
      log_retention_days: 30,
      message_delay_ms: 2000,
      max_retries: 3,
      defaultInterTargetDelaySec: 8,
      defaultIntraTargetDelaySec: 3,
      processingTimeoutMinutes: 30,
      dedupeThreshold: 0.88
    }
  });

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Configure global defaults and safety controls.</p>
      </div>

      <form onSubmit={form.handleSubmit((values) => saveSettings.mutate(values))} className="space-y-6">
        <Card id="general">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              General
            </CardTitle>
            <CardDescription>Basic application settings</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="app_name">App Name</Label>
              <Input id="app_name" {...form.register('app_name')} />
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
            <CardDescription>Configure delays, retries, and queue behavior</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2" id="delays">
              <Label htmlFor="message_delay_ms">Message Delay (ms)</Label>
              <Input id="message_delay_ms" type="number" {...form.register('message_delay_ms', { valueAsNumber: true })} />
              <p className="text-xs text-muted-foreground">Delay between messages to avoid rate limiting</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="max_retries">Max Retries</Label>
              <Input id="max_retries" type="number" {...form.register('max_retries', { valueAsNumber: true })} />
              <p className="text-xs text-muted-foreground">Retry failed sends before marking failed</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="defaultInterTargetDelaySec">Inter-target Delay (sec)</Label>
              <Input
                id="defaultInterTargetDelaySec"
                type="number"
                {...form.register('defaultInterTargetDelaySec', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">Delay between different targets</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="defaultIntraTargetDelaySec">Intra-target Delay (sec)</Label>
              <Input
                id="defaultIntraTargetDelaySec"
                type="number"
                {...form.register('defaultIntraTargetDelaySec', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">Delay between messages to the same target</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="processingTimeoutMinutes">Processing Timeout (min)</Label>
              <Input
                id="processingTimeoutMinutes"
                type="number"
                {...form.register('processingTimeoutMinutes', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">Reset stuck processing logs after this window</p>
            </div>
            <div className="space-y-2" id="retention">
              <Label htmlFor="log_retention_days">Log Retention (days)</Label>
              <Input id="log_retention_days" type="number" {...form.register('log_retention_days', { valueAsNumber: true })} />
              <p className="text-xs text-muted-foreground">How long to keep message logs</p>
            </div>
          </CardContent>
        </Card>

        <Card id="dedupe">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Copy className="h-5 w-5" />
              Duplicate Detection
            </CardTitle>
            <CardDescription>Prevent sending duplicate articles</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
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
                0.88 = strict (88% similar titles are duplicates). Lower = more aggressive deduplication.
              </p>
            </div>
            <div className="rounded-lg border bg-muted/50 p-4 space-y-2 text-sm">
              <p className="font-medium">How it works:</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>Exact URL matches are always detected</li>
                <li>Similar titles are compared using fuzzy matching</li>
                <li>Only items within the retention period are checked</li>
              </ul>
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
