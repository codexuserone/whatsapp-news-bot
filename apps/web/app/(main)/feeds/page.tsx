'use client';

import React, { useEffect, useState } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Feed, Schedule } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Rss, TestTube, Pencil, Trash2, CheckCircle, XCircle, Loader2, RefreshCw, PauseCircle, PlayCircle } from 'lucide-react';

const schema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  active: z.boolean().default(true),
  fetch_interval: z.coerce.number().min(300)
});

type FeedFormValues = z.infer<typeof schema>;

type FeedTestResult = {
  error?: string;
  feedTitle?: string;
  detectedType?: string | null;
  itemCount?: number;
  detectedFields?: string[];
  sampleItem?: Record<string, unknown>;
};


const FeedsPage = () => {
  const queryClient = useQueryClient();
  const { data: feeds = [] } = useQuery<Feed[]>({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const { data: schedules = [] } = useQuery<Schedule[]>({ queryKey: ['schedules'], queryFn: () => api.get('/api/schedules') });
  const [active, setActive] = useState<Feed | null>(null);
  const [testResult, setTestResult] = useState<FeedTestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error');

  const form = useForm<FeedFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      url: '',
      active: true,
      fetch_interval: 900
    }
  });

  const watchedUrl = useWatch({ control: form.control, name: 'url' });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        url: active.url,
        active: Boolean(active.active),
        fetch_interval: active.fetch_interval || 900
      });
    }
  }, [active, form]);

  const selectFeed = (feed: Feed) => {
    setActive(feed);
    setTestResult(null);
  };

  const saveFeed = useMutation({
    mutationFn: (payload: FeedFormValues) =>
      active ? api.put(`/api/feeds/${active.id}`, payload) : api.post('/api/feeds', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
      setActive(null);
      setTestResult(null);
      form.reset();
    },
    onError: (error: unknown) => alert(`Failed to save feed: ${getErrorMessage(error)}`)
  });

  const deleteFeed = useMutation({
    mutationFn: (id: string) => api.delete(`/api/feeds/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
    },
    onError: (error: unknown) => alert(`Failed to delete feed: ${getErrorMessage(error)}`)
  });

  const refreshFeed = useMutation({
    mutationFn: (id: string) => api.post(`/api/feeds/${id}/refresh`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      queryClient.invalidateQueries({ queryKey: ['feed-items'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
    },
    onError: (error: unknown) => alert(`Failed to refresh feed: ${getErrorMessage(error)}`)
  });

  const toggleFeedActive = useMutation({
    mutationFn: (feed: Feed) =>
      api.put(`/api/feeds/${feed.id}`, {
        name: feed.name,
        url: feed.url,
        type: feed.type,
        active: !feed.active,
        fetch_interval: feed.fetch_interval || 900
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error: unknown) => alert(`Failed to update feed state: ${getErrorMessage(error)}`)
  });


  const testFeedUrl = async () => {
    const url = form.getValues('url');
    if (!url) return;

    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await api.post<FeedTestResult>('/api/feeds/test', { url });
      setTestResult(result);
      if (!form.getValues('name') && result.feedTitle) {
        form.setValue('name', result.feedTitle);
      }
    } catch (error: unknown) {
      setTestResult({ error: getErrorMessage(error) || 'Failed to test feed' });
    }
    setTestLoading(false);
  };

  const onSubmit = (values: FeedFormValues) => {
    saveFeed.mutate(values);
  };

  const activeAutomationCountByFeedId = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const schedule of schedules) {
      if (!schedule?.active || !schedule?.feed_id) continue;
      const feedId = String(schedule.feed_id);
      map.set(feedId, (map.get(feedId) || 0) + 1);
    }
    return map;
  }, [schedules]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Feeds</h1>
          <p className="text-muted-foreground">Add feed URLs. Active automations fetch these automatically; use Fetch now only when needed.</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Rss className="h-5 w-5" />
                {active ? 'Edit Feed' : 'Add Feed'}
              </CardTitle>
              <CardDescription>
                {active ? 'Update the feed configuration' : 'Enter a feed URL to get started'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="url">Feed URL</Label>
                  <div className="flex gap-2">
                    <Input id="url" {...form.register('url')} placeholder="https://example.com/feed" className="flex-1" />
                    <Button type="button" variant="outline" onClick={testFeedUrl} disabled={testLoading || !watchedUrl}>
                      {testLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TestTube className="mr-2 h-4 w-4" />}
                      Test
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="name">Name</Label>
                    <Input id="name" {...form.register('name')} placeholder="Auto-detected from feed" />
                  </div>
                  <div className="space-y-2">
                    <Label>Type</Label>
                    <div className="flex h-10 items-center justify-between rounded-md border bg-muted/30 px-3 text-sm">
                      <span className="text-muted-foreground">Auto-detect</span>
                      <Badge variant="secondary" className="capitalize">
                        {testResult?.detectedType || active?.type || 'rss'}
                      </Badge>
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="fetch_interval">Auto-check interval</Label>
                    <Controller
                      control={form.control}
                      name="fetch_interval"
                      render={({ field }) => {
                        const value = String(field.value || 900);
                        return (
                          <Select value={value} onValueChange={(next) => field.onChange(Number(next))}>
                            <SelectTrigger id="fetch_interval">
                              <SelectValue placeholder="Select interval" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="300">Every 5 minutes</SelectItem>
                              <SelectItem value="900">Every 15 minutes</SelectItem>
                              <SelectItem value="1800">Every 30 minutes</SelectItem>
                              <SelectItem value="3600">Every 60 minutes</SelectItem>
                            </SelectContent>
                          </Select>
                        );
                      }}
                    />
                    <p className="text-xs text-muted-foreground">Used when this feed is attached to active automations.</p>
                  </div>
                  <Controller
                    control={form.control}
                    name="active"
                    render={({ field }) => (
                      <div className="flex items-center gap-2 pt-8">
                        <Checkbox
                          id="active"
                          checked={field.value}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                        />
                        <Label htmlFor="active" className="cursor-pointer">Active</Label>
                      </div>
                    )}
                  />
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  <Button type="submit" disabled={saveFeed.isPending}>
                    {saveFeed.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {active ? 'Update Feed' : 'Save Feed'}
                  </Button>
                  {active && (
                    <Button type="button" variant="outline" onClick={() => { setActive(null); setTestResult(null); form.reset(); }}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>

          {testResult && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Feed Test Result
                  {testResult.error ? (
                    <Badge variant="destructive">
                      <XCircle className="mr-1 h-3 w-3" /> Error
                    </Badge>
                  ) : (
                    <Badge variant="success">
                      <CheckCircle className="mr-1 h-3 w-3" /> Valid
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {testResult.error ? (
                  <p className="text-sm text-destructive">{testResult.error}</p>
                ) : (
                  <div className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Feed Title</p>
                        <p className="text-sm">{testResult.feedTitle || 'Unknown'}</p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Items Found</p>
                        <p className="text-sm">{testResult.itemCount || 0} items</p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Detected Type</p>
                        <p className="text-sm capitalize">{testResult.detectedType || 'unknown'}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-2">Detected Variables (use in templates)</p>
                      <div className="flex flex-wrap gap-2">
                        {(testResult.detectedFields || []).map((field: string) => (
                          <Badge key={field} variant="secondary" className="font-mono">
                            {`{{${field}}}`}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    {testResult.sampleItem && (
                      <div>
                        <p className="text-sm font-medium text-muted-foreground mb-2">Sample Item</p>
                        <div className="rounded-lg border bg-muted/50 p-3 space-y-1">
                          {Object.entries(testResult.sampleItem).map(([key, value]) => (
                            <div key={key} className="text-xs">
                              <span className="font-medium text-primary font-mono">{key}:</span>{' '}
                              <span className="text-muted-foreground">
                                {String(value || '').slice(0, 100)}
                                {String(value || '').length > 100 ? '...' : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Saved Feeds</CardTitle>
            <CardDescription>{feeds.length} feed{feeds.length !== 1 ? 's' : ''} configured</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {feeds.map((feed) => (
                <div key={feed.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{feed.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{feed.url}</p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          Active automations: {activeAutomationCountByFeedId.get(feed.id) || 0}
                        </span>
                        <span>
                          Last fetched:{' '}
                          {feed.last_fetched_at ? new Date(feed.last_fetched_at).toLocaleString() : '—'}
                        </span>
                        <span>
                          Last success:{' '}
                          {feed.last_success_at ? new Date(feed.last_success_at).toLocaleString() : '—'}
                        </span>
                        {(feed.consecutive_failures || 0) > 0 ? (
                          <span className="text-destructive">
                            Failures: {feed.consecutive_failures}
                          </span>
                        ) : null}
                        {feed.last_error ? (
                          <span className="text-destructive" title={feed.last_error}>
                            Error: {String(feed.last_error).slice(0, 80)}
                            {String(feed.last_error).length > 80 ? '…' : ''}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <Badge variant={feed.active ? 'success' : 'secondary'}>{feed.active ? 'Active' : 'Paused'}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => selectFeed(feed)}>
                      <Pencil className="mr-1 h-3 w-3" /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggleFeedActive.mutate(feed)}
                      disabled={toggleFeedActive.isPending}
                    >
                      {feed.active ? <PauseCircle className="mr-1 h-3 w-3" /> : <PlayCircle className="mr-1 h-3 w-3" />}
                      {feed.active ? 'Pause feed' : 'Resume feed'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => refreshFeed.mutate(feed.id)} disabled={refreshFeed.isPending}>
                      {refreshFeed.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                      Fetch now
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteFeed.mutate(feed.id)} className="text-destructive hover:text-destructive">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
              {feeds.length === 0 && (
                <p className="text-center text-muted-foreground py-8">No feeds yet. Add a feed URL to get started.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default FeedsPage;
