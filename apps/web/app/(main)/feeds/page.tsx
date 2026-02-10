'use client';

import React, { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Feed, Schedule } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Rss, TestTube, Pencil, Trash2, CheckCircle, XCircle, Loader2 } from 'lucide-react';

const schema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  type: z.enum(['rss', 'atom', 'json', 'html']).optional(),
  fetch_interval: z.coerce.number().min(300)
});

type FeedFormValues = z.infer<typeof schema>;

type FeedTestResult = {
  error?: string;
  feedTitle?: string;
  detectedType?: string | null;
  sourceUrl?: string | null;
  discoveredFromUrl?: string | null;
  itemCount?: number;
  detectedFields?: string[];
  sampleItem?: Record<string, unknown>;
};

type DeleteFeedResponse = {
  ok?: boolean;
  rateLimited?: boolean;
  deactivated?: boolean;
  message?: string;
};

const FeedsPage = () => {
  const queryClient = useQueryClient();
  const { data: feeds = [] } = useQuery<Feed[]>({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const { data: schedules = [] } = useQuery<Schedule[]>({ queryKey: ['schedules'], queryFn: () => api.get('/api/schedules') });
  const [active, setActive] = useState<Feed | null>(null);
  const [testResult, setTestResult] = useState<FeedTestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error');
  const isRateLimitedError = (error: unknown) => {
    const message = getErrorMessage(error).toLowerCase();
    return message.includes('too many requests') || message.includes('rate limit') || message.includes('rate limited');
  };

  const form = useForm<FeedFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      url: '',
      fetch_interval: 900
    }
  });

  const watchedUrl = useWatch({ control: form.control, name: 'url' });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        url: active.url,
        type: active.type,
        fetch_interval: active.fetch_interval || 900
      });
    }
  }, [active, form]);

  const selectFeed = (feed: Feed) => {
    setActive(feed);
    setTestResult(null);
  };

  const saveFeed = useMutation({
    mutationFn: ({ feedId, payload }: { feedId: string | null; payload: FeedFormValues }) => {
      const body = {
        ...payload,
        active: active ? Boolean(active.active) : true
      };
      return feedId ? api.put<Feed>(`/api/feeds/${feedId}`, body) : api.post<Feed>('/api/feeds', body);
    },
    onSuccess: (savedFeed: Feed) => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
      setActive(savedFeed);
      setTestResult(null);
      form.reset({
        name: savedFeed.name || '',
        url: savedFeed.url || '',
        type: savedFeed.type || undefined,
        fetch_interval: savedFeed.fetch_interval || 900
      });
    },
    onError: (error: unknown) => alert(`Failed to save feed: ${getErrorMessage(error)}`)
  });

  const deleteFeed = useMutation({
    mutationFn: async (id: string) => {
      try {
        return await api.delete<DeleteFeedResponse>(`/api/feeds/${id}`);
      } catch (error) {
        if (!isRateLimitedError(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return api.delete<DeleteFeedResponse>(`/api/feeds/${id}`);
      }
    },
    onSuccess: (result, id) => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
      if (result?.rateLimited) {
        alert(
          result.message ||
            (result?.deactivated
              ? 'Feed is paused for now. Delete again in a few seconds to remove it fully.'
              : 'Delete is rate-limited right now. Retry in a few seconds.')
        );
      }
      if (active?.id === id) {
        setActive(null);
        setTestResult(null);
        form.reset({
          name: '',
          url: '',
          type: undefined,
          fetch_interval: 900
        });
      }
    },
    onError: (error: unknown) => {
      const message = getErrorMessage(error);
      if (isRateLimitedError(error)) {
        alert('Delete is temporarily rate-limited. Wait a few seconds and try once more.');
        return;
      }
      alert(`Failed to delete feed: ${message}`);
    }
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
      if (
        result.detectedType === 'rss' ||
        result.detectedType === 'atom' ||
        result.detectedType === 'json' ||
        result.detectedType === 'html'
      ) {
        form.setValue('type', result.detectedType);
      }
    } catch (error: unknown) {
      setTestResult({ error: getErrorMessage(error) || 'Failed to test feed' });
    }
    setTestLoading(false);
  };

  const onSubmit = (values: FeedFormValues) => {
    saveFeed.mutate({
      feedId: active?.id || null,
      payload: values
    });
  };

  const activeAutomationCountByFeedId = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const schedule of schedules) {
      const isRunning = schedule?.state ? schedule.state === 'active' : Boolean(schedule?.active);
      if (!isRunning || !schedule?.feed_id) continue;
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
          <p className="text-muted-foreground">Add feed URLs. Running automations check these feeds automatically.</p>
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
                      Check URL
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
                      <span className="text-muted-foreground">
                        {form.getValues('type') ? 'Detected' : 'Auto-detect'}
                      </span>
                      <Badge variant="secondary" className="capitalize">
                        {form.getValues('type') || testResult?.detectedType || active?.type || 'auto'}
                      </Badge>
                    </div>
                    <input type="hidden" {...form.register('type')} />
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  Feed polling only runs when at least one running automation uses this feed.
                </p>

                <input type="hidden" {...form.register('fetch_interval')} value={900} />

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
                  URL Check
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
                    {testResult.sourceUrl ? (
                      <div className="space-y-1 text-sm">
                        <p className="font-medium text-muted-foreground">Source URL used</p>
                        <p className="break-all">{testResult.sourceUrl}</p>
                        {testResult.discoveredFromUrl ? (
                          <p className="text-xs text-muted-foreground">
                            Auto-discovered from: {testResult.discoveredFromUrl}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-2">Detected fields (available in templates)</p>
                      <div className="flex flex-wrap gap-2">
                        {(testResult.detectedFields || []).map((field: string) => (
                          <Badge key={field} variant="secondary">
                            {field.replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </div>
                    </div>
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
                  {(() => {
                    const runningAutomationCount = activeAutomationCountByFeedId.get(feed.id) || 0;
                    const pollingEnabled = Boolean(feed.active) && runningAutomationCount > 0;
                    const badgeLabel = !feed.active ? 'Disabled' : pollingEnabled ? 'Polling' : 'Idle';
                    const badgeVariant = pollingEnabled ? 'success' : 'secondary';
                    return (
                      <>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{feed.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{feed.url}</p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          Active automations: {activeAutomationCountByFeedId.get(feed.id) || 0}
                        </span>
                        <span>
                          Last checked:{' '}
                          {feed.last_fetched_at ? new Date(feed.last_fetched_at).toLocaleString() : '-'}
                        </span>
                        {feed.last_error ? (
                          <span className="text-destructive" title={feed.last_error}>
                            Error: {String(feed.last_error).slice(0, 80)}
                            {String(feed.last_error).length > 80 ? '...' : ''}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <Badge variant={badgeVariant}>{badgeLabel}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => selectFeed(feed)}>
                      <Pencil className="mr-1 h-3 w-3" /> Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteFeed.mutate(feed.id)} className="text-destructive hover:text-destructive">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                      </>
                    );
                  })()}
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
