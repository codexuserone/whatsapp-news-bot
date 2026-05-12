'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BackendSettings, ShabbosSettings, ShabbosStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Clock, MapPin, Loader2, Copy, AlertCircle, CheckCircle2 } from 'lucide-react';

const WHATSAPP_EDIT_MAX_MINUTES = 15;
const CORRECTION_SCAN_MAX_MINUTES = 15;

const optionalNumberInput = (schema: z.ZodNumber) =>
  z.preprocess((value) => {
    if (value === '' || value == null) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }, schema.optional());

const schema = z.object({
  app_name: z.string().min(1),
  app_paused: z.boolean().default(false),
  default_timezone: z.string().min(1),
  message_delay_ms: z.coerce.number().min(0),
  post_send_edit_window_minutes: z.coerce.number().min(1).max(WHATSAPP_EDIT_MAX_MINUTES),
  post_send_correction_window_minutes: z.coerce.number().min(1).max(CORRECTION_SCAN_MAX_MINUTES),
  dedupeThreshold: optionalNumberInput(z.number().min(0).max(1)),
  status_audience_mode: z.enum(['auto', 'explicit']).default('auto'),
  status_audience_jids: z.string().max(12000).default(''),
  status_test_audience_jids: z.string().max(12000).default(''),
  status_include_group_participants: z.boolean().default(true),
  status_include_sender: z.boolean().default(false)
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
type SettingsSavePayload = SettingsFormValues & Record<string, unknown>;

type SaveNotice =
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'validation'; message: string };

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

const SEND_PACE_OPTIONS = [
  { label: 'Fast', value: 1000, description: 'Use for small test sends.' },
  { label: 'Normal', value: 2000, description: 'Balanced default for daily publishing.' },
  { label: 'Careful', value: 5000, description: 'Adds more space between messages.' }
];

const SYSTEM_SETTING_KEYS = [
  'log_retention_days',
  'max_retries',
  'defaultInterTargetDelaySec',
  'defaultIntraTargetDelaySec',
  'processingTimeoutMinutes',
  'authRetentionDays',
  'initial_fetch_limit',
  'max_pending_age_hours',
  'send_timeout_ms',
  'reconcile_queue_lookback_hours',
  'retentionDays'
] as const;

const formatStatusAudienceText = (value: unknown) =>
  Array.from(
    new Set(
      String(value || '')
        .split(/[\n,]+/)
        .map((entry) => {
          const raw = entry.trim();
          if (!raw) return '';
          const user = raw.split('@')[0]?.split(':')[0] || raw;
          const digits = user.replace(/[^0-9]/g, '');
          if ((raw.endsWith('@s.whatsapp.net') || raw.endsWith('@c.us')) && digits.length >= 6) {
            return `+${digits}`;
          }
          return raw;
        })
        .filter(Boolean)
    )
  ).join('\n');

const toSettingsFormValues = (settings?: Partial<BackendSettings> | null): SettingsFormValues => ({
  app_name: String(settings?.app_name || 'WhatsApp News Bot'),
  app_paused: settings?.app_paused === true,
  default_timezone: String(settings?.default_timezone || 'UTC'),
  message_delay_ms: Number(settings?.message_delay_ms ?? 2000),
  post_send_edit_window_minutes: Number(settings?.post_send_edit_window_minutes ?? 15),
  post_send_correction_window_minutes: Number(settings?.post_send_correction_window_minutes ?? 15),
  dedupeThreshold:
    settings?.dedupeThreshold == null
      ? undefined
      : Number(settings.dedupeThreshold),
  status_audience_mode: settings?.status_audience_mode === 'explicit' ? 'explicit' : 'auto',
  status_audience_jids: formatStatusAudienceText(settings?.status_audience_jids || ''),
  status_test_audience_jids: formatStatusAudienceText(settings?.status_test_audience_jids || ''),
  status_include_group_participants: settings?.status_include_group_participants !== false,
  status_include_sender: settings?.status_include_sender === true
});

const preserveSystemSettings = (settings?: Partial<BackendSettings> | null): Record<string, unknown> => {
  if (!settings) return {};
  return Object.fromEntries(
    SYSTEM_SETTING_KEYS
      .filter((key) => settings[key] !== undefined)
      .map((key) => [key, settings[key]])
  );
};

const SettingsPage = () => {
  const queryClient = useQueryClient();
  const [saveNotice, setSaveNotice] = useState<SaveNotice | null>(null);
  const [showDuplicateFilter, setShowDuplicateFilter] = useState(false);
  const { data: settings, isLoading: isSettingsLoading } = useQuery<BackendSettings>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings')
  });
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
  const defaultFormValues = useMemo(() => toSettingsFormValues(settings), [settings]);

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaultFormValues
  });
  const appPaused = useWatch({ control: form.control, name: 'app_paused' });
  const statusAudienceMode = useWatch({ control: form.control, name: 'status_audience_mode' });

  useEffect(() => {
    if (settings) {
      form.reset(toSettingsFormValues(settings));
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

  const saveSettings = useMutation<BackendSettings, Error, SettingsSavePayload>({
    mutationFn: (payload) => api.put<BackendSettings>('/api/settings', payload),
    onSuccess: async (data) => {
      const nextValues = toSettingsFormValues(data);
      queryClient.setQueryData(['settings'], data);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
        queryClient.invalidateQueries({ queryKey: ['schedules'] }),
        queryClient.invalidateQueries({ queryKey: ['queue'] }),
        queryClient.invalidateQueries({ queryKey: ['queue-stats'] }),
        queryClient.invalidateQueries({ queryKey: ['feed-items'] })
      ]);
      form.reset(nextValues);
      setSaveNotice({
        kind: 'success',
        message: `Settings saved at ${new Date().toLocaleTimeString()}.`
      });
    },
    onError: (error: Error) => {
      setSaveNotice({
        kind: 'error',
        message: error.message || 'Settings could not be saved.'
      });
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
    setSaveNotice(null);
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
      ...preserveSystemSettings(settings),
      ...values,
      post_send_edit_window_minutes: editWindow,
      post_send_correction_window_minutes: correctionWindow
    });
  };

  const submitInvalidSettings = () => {
    const messages = Object.values(form.formState.errors)
      .map((issue) => issue?.message)
      .filter((message): message is string => Boolean(message));
    setSaveNotice({
      kind: 'validation',
      message: messages[0] || 'Fix the highlighted settings and try again.'
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Set publishing behavior, Status delivery, and Shabbos mode.</p>
      </div>

      {isSettingsLoading ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading current settings...
          </CardContent>
        </Card>
      ) : (
      <form onSubmit={form.handleSubmit(submitSettings, submitInvalidSettings)} className="space-y-6">
        {saveNotice ? (
          <div
            className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
              saveNotice.kind === 'success'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
                : saveNotice.kind === 'validation'
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                  : 'border-destructive/40 bg-destructive/10 text-destructive'
            }`}
          >
            {saveNotice.kind === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <p>{saveNotice.message}</p>
          </div>
        ) : null}

        <Card id="general">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Publishing
            </CardTitle>
            <CardDescription>One global stop switch for feed checks and scheduled sends.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3 sm:col-span-2 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Stop publishing</p>
                  <p className="text-xs text-muted-foreground">
                    Stops feed checks, queueing, and scheduled sends until turned back on.
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
                <Badge variant="warning">Publishing stopped</Badge>
              ) : (
                <Badge variant="success">Publishing on</Badge>
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
                    <Select key={`default-timezone-${value}`} value={value} onValueChange={field.onChange}>
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
            <CardDescription>Normal operator defaults.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Controller
              control={form.control}
              name="message_delay_ms"
              render={({ field }) => {
                const current = Number(field.value || 2000);
                return (
                  <div className="space-y-3" id="delays">
                    <Label>Send Pace</Label>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {SEND_PACE_OPTIONS.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant={current === option.value ? 'default' : 'outline'}
                          className="h-auto justify-start whitespace-normal py-3 text-left"
                          onClick={() => field.onChange(option.value)}
                        >
                          <span>
                            <span className="block font-medium">{option.label}</span>
                            <span className="block text-xs opacity-80">{option.description}</span>
                          </span>
                        </Button>
                      ))}
                    </div>
                  </div>
                );
              }}
            />
          </CardContent>
        </Card>

        <Card id="status">
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>Choose who receives production Status posts and previews.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
              <div>
                <Label>Production Audience</Label>
                <p className="text-xs text-muted-foreground">
                  Production sends to everyone WhatsApp can reach unless you choose a smaller phone list.
                </p>
              </div>
              <Controller
                control={form.control}
                name="status_audience_mode"
                render={({ field }) => (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      type="button"
                      variant={field.value === 'auto' ? 'default' : 'outline'}
                      onClick={() => field.onChange('auto')}
                    >
                      All available viewers
                    </Button>
                    <Button
                      type="button"
                      variant={field.value === 'explicit' ? 'default' : 'outline'}
                      onClick={() => field.onChange('explicit')}
                    >
                      Only selected phones
                    </Button>
                  </div>
                )}
              />
              {statusAudienceMode === 'explicit' ? (
                <div className="space-y-2">
                  <Label htmlFor="status_audience_jids">Production Status Phone Numbers</Label>
                  <Textarea
                    id="status_audience_jids"
                    rows={3}
                    placeholder="+1 914 447 7725"
                    {...form.register('status_audience_jids')}
                  />
                  <p className="text-xs text-muted-foreground">One phone number per line.</p>
                </div>
              ) : null}
              {statusAudienceMode === 'auto' ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 p-4">
                  <div>
                    <p className="text-sm font-medium">Use synced viewers</p>
                    <p className="text-xs text-muted-foreground">
                      Sends production Status posts to viewers WhatsApp exposes to this session.
                    </p>
                  </div>
                  <Controller
                    control={form.control}
                    name="status_include_group_participants"
                    render={({ field }) => (
                      <Switch
                        checked={field.value === true}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                    )}
                  />
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="status_test_audience_jids">Status Preview Phone Numbers</Label>
              <Textarea
                id="status_test_audience_jids"
                rows={3}
                placeholder="+1 914 447 7725"
                {...form.register('status_test_audience_jids')}
              />
              <p className="text-xs text-muted-foreground">
                Preview Status sends only go to this phone list.
              </p>
            </div>
          </CardContent>
        </Card>

        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowDuplicateFilter((current) => !current)}
          >
            {showDuplicateFilter ? 'Hide duplicate filter' : 'Duplicate filter'}
          </Button>
        </div>

        {showDuplicateFilter ? (
        <Card id="dedupe">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Copy className="h-5 w-5" />
              Duplicate Filter
            </CardTitle>
            <CardDescription>Optional: block near-duplicate stories when the feed repeats similar posts.</CardDescription>
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
        ) : null}

        <Button type="submit" disabled={saveSettings.isPending}>
          {saveSettings.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {saveSettings.isPending ? 'Saving Settings...' : 'Save Settings'}
        </Button>
      </form>
      )}

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
