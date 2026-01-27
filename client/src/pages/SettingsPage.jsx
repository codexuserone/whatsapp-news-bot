import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';

const schema = z.object({
  retentionDays: z.coerce.number().min(1),
  authRetentionDays: z.coerce.number().min(1),
  defaultInterTargetDelaySec: z.coerce.number().min(1),
  defaultIntraTargetDelaySec: z.coerce.number().min(1),
  dedupeThreshold: z.coerce.number().min(0.5).max(1)
});

const SettingsPage = () => {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      retentionDays: 14,
      authRetentionDays: 60,
      defaultInterTargetDelaySec: 8,
      defaultIntraTargetDelaySec: 3,
      dedupeThreshold: 0.88
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
        <Card id="retention">
          <CardHeader>
            <CardTitle>Retention</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Retention Days</label>
              <Input type="number" {...form.register('retentionDays', { valueAsNumber: true })} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Auth Retention Days</label>
              <Input type="number" {...form.register('authRetentionDays', { valueAsNumber: true })} />
            </div>
          </CardContent>
        </Card>

        <Card id="delays">
          <CardHeader>
            <CardTitle>Delays</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Inter-target Delay (sec)</label>
              <Input type="number" {...form.register('defaultInterTargetDelaySec', { valueAsNumber: true })} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Intra-target Delay (sec)</label>
              <Input type="number" {...form.register('defaultIntraTargetDelaySec', { valueAsNumber: true })} />
            </div>
          </CardContent>
        </Card>

        <Card id="dedupe">
          <CardHeader>
            <CardTitle>Dedupe</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <label className="text-sm font-medium">Fuzzy Match Threshold (0.5 - 1.0)</label>
              <Input type="number" step="0.01" {...form.register('dedupeThreshold', { valueAsNumber: true })} />
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
