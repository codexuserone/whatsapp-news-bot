import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Badge } from '../components/ui/badge';

const schema = z.object({
  app_name: z.string().min(1),
  default_timezone: z.string().min(1),
  log_retention_days: z.coerce.number().min(1),
  message_delay_ms: z.coerce.number().min(100)
});

// Common locations for Shabbos times
const PRESET_LOCATIONS = [
  { name: 'New York', latitude: 40.7128, longitude: -74.006, tzid: 'America/New_York' },
  { name: 'Los Angeles', latitude: 34.0522, longitude: -118.2437, tzid: 'America/Los_Angeles' },
  { name: 'Chicago', latitude: 41.8781, longitude: -87.6298, tzid: 'America/Chicago' },
  { name: 'Miami', latitude: 25.7617, longitude: -80.1918, tzid: 'America/New_York' },
  { name: 'Jerusalem', latitude: 31.7683, longitude: 35.2137, tzid: 'Asia/Jerusalem' },
  { name: 'London', latitude: 51.5074, longitude: -0.1278, tzid: 'Europe/London' },
  { name: 'Montreal', latitude: 45.5017, longitude: -73.5673, tzid: 'America/Montreal' },
  { name: 'Toronto', latitude: 43.6532, longitude: -79.3832, tzid: 'America/Toronto' },
];

const SettingsPage = () => {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      app_name: 'Anash WhatsApp Bot',
      default_timezone: 'UTC',
      log_retention_days: 30,
      message_delay_ms: 2000
    }
  });

  useEffect(() => {
    if (settings) {
      form.reset(settings);
    }
  }, [settings, form]);

  const saveSettings = useMutation({
    mutationFn: (payload) => api.put('/api/settings', payload),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data);
    }
  });

  return (
    <div className="space-y-8">
      <PageHeader title="Settings" subtitle="Tune global defaults, retention windows, and safety controls." />
      <form onSubmit={form.handleSubmit((values) => saveSettings.mutate(values))} className="space-y-6">
        <Card id="general">
          <CardHeader>
            <CardTitle>General</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">App Name</label>
              <Input {...form.register('app_name')} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Default Timezone</label>
              <Input {...form.register('default_timezone')} placeholder="UTC" />
            </div>
          </CardContent>
        </Card>

        <Card id="messaging">
          <CardHeader>
            <CardTitle>Messaging</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Message Delay (ms)</label>
              <Input type="number" {...form.register('message_delay_ms', { valueAsNumber: true })} />
              <p className="text-xs text-ink/50">Delay between sending messages to avoid rate limiting</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Log Retention (days)</label>
              <Input type="number" {...form.register('log_retention_days', { valueAsNumber: true })} />
              <p className="text-xs text-ink/50">How long to keep message logs</p>
            </div>
          </CardContent>
        </Card>

        <Button type="submit" disabled={saveSettings.isPending}>
          Save Settings
        </Button>
      </form>
    </div>
  );
};

export default SettingsPage;
