import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Select } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';

const schema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  type: z.enum(['rss', 'atom', 'json']),
  enabled: z.boolean().default(true),
  fetchIntervalMinutes: z.coerce.number().min(5),
  itemsPath: z.string().optional(),
  titlePath: z.string().optional(),
  linkPath: z.string().optional(),
  descriptionPath: z.string().optional(),
  imagePath: z.string().optional(),
  removePhrases: z.string().optional(),
  stripUtm: z.boolean().default(true),
  decodeEntities: z.boolean().default(true)
});

const FeedsPage = () => {
  const queryClient = useQueryClient();
  const { data: feeds = [] } = useQuery({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const [active, setActive] = useState(null);

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      url: '',
      type: 'rss',
      enabled: true,
      fetchIntervalMinutes: 15,
      itemsPath: '',
      titlePath: '',
      linkPath: '',
      descriptionPath: '',
      imagePath: '',
      removePhrases: '',
      stripUtm: true,
      decodeEntities: true
    }
  });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        url: active.url,
        type: active.type,
        enabled: Boolean(active.enabled),
        fetchIntervalMinutes: active.fetchIntervalMinutes || 15,
        itemsPath: active.parseConfig?.itemsPath || '',
        titlePath: active.parseConfig?.titlePath || '',
        linkPath: active.parseConfig?.linkPath || '',
        descriptionPath: active.parseConfig?.descriptionPath || '',
        imagePath: active.parseConfig?.imagePath || '',
        removePhrases: (active.cleaning?.removePhrases || []).join('\n'),
        stripUtm: active.cleaning?.stripUtm ?? true,
        decodeEntities: active.cleaning?.decodeEntities ?? true
      });
    }
  }, [active, form]);

  const saveFeed = useMutation({
    mutationFn: (payload) =>
      active ? api.put(`/api/feeds/${active._id}`, payload) : api.post('/api/feeds', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      setActive(null);
      form.reset();
    }
  });

  const deleteFeed = useMutation({
    mutationFn: (id) => api.delete(`/api/feeds/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['feeds'] })
  });

  const refreshFeed = useMutation({
    mutationFn: (id) => api.post(`/api/feeds/${id}/refresh`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['feed-items'] })
  });

  const onSubmit = (values) => {
    const payload = {
      name: values.name,
      url: values.url,
      type: values.type,
      enabled: values.enabled,
      fetchIntervalMinutes: values.fetchIntervalMinutes,
      parseConfig: {
        itemsPath: values.itemsPath || undefined,
        titlePath: values.titlePath || undefined,
        linkPath: values.linkPath || undefined,
        descriptionPath: values.descriptionPath || undefined,
        imagePath: values.imagePath || undefined
      },
      cleaning: {
        removePhrases: values.removePhrases
          ? values.removePhrases.split('\n').map((phrase) => phrase.trim()).filter(Boolean)
          : [],
        stripUtm: values.stripUtm,
        decodeEntities: values.decodeEntities
      }
    };

    saveFeed.mutate(payload);
  };

  return (
    <div className="space-y-8">
      <PageHeader title="Feeds" subtitle="Register RSS, Atom, or JSON feeds with cleaning rules." />

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{active ? 'Edit Feed' : 'Create Feed'}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <Input {...form.register('name')} placeholder="Anash RSS" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">URL</label>
                  <Input {...form.register('url')} placeholder="https://anash.org/feed" />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Type</label>
                  <Select {...form.register('type')}>
                    <option value="rss">RSS</option>
                    <option value="atom">Atom</option>
                    <option value="json">JSON</option>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Fetch Interval (min)</label>
                  <Input type="number" {...form.register('fetchIntervalMinutes', { valueAsNumber: true })} />
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
              </div>

              <div className="rounded-2xl border border-ink/10 bg-surface p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">JSON Mapping</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <Input {...form.register('itemsPath')} placeholder="items" />
                  <Input {...form.register('titlePath')} placeholder="title" />
                  <Input {...form.register('linkPath')} placeholder="link" />
                  <Input {...form.register('descriptionPath')} placeholder="description" />
                  <Input {...form.register('imagePath')} placeholder="image" />
                </div>
              </div>

              <div className="rounded-2xl border border-ink/10 bg-surface p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Cleaning Rules</p>
                <div className="mt-3 space-y-3">
                  <Textarea {...form.register('removePhrases')} placeholder="One phrase per line" />
                  <div className="flex flex-wrap gap-4">
                    <Controller
                      control={form.control}
                      name="stripUtm"
                      render={({ field }) => (
                        <label className="flex items-center gap-2 text-sm font-medium">
                          <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
                          Strip UTM params
                        </label>
                      )}
                    />
                    <Controller
                      control={form.control}
                      name="decodeEntities"
                      render={({ field }) => (
                        <label className="flex items-center gap-2 text-sm font-medium">
                          <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
                          Decode HTML entities
                        </label>
                      )}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saveFeed.isPending}>
                  {active ? 'Update Feed' : 'Save Feed'}
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
            <CardTitle>Existing Feeds</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {feeds.map((feed) => (
                  <TableRow key={feed._id}>
                    <TableCell>{feed.name}</TableCell>
                    <TableCell className="uppercase text-ink/60">{feed.type}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setActive(feed)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => refreshFeed.mutate(feed._id)}>
                          Refresh
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteFeed.mutate(feed._id)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {feeds.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-ink/50">
                      No feeds configured.
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

export default FeedsPage;
