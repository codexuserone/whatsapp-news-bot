import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Label } from '../components/ui/label';
import { Rss, TestTube, RefreshCw, Pencil, Trash2, CheckCircle, XCircle, Loader2 } from 'lucide-react';

const schema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  type: z.enum(['rss', 'atom', 'json']),
  active: z.boolean().default(true),
  fetch_interval: z.coerce.number().min(300)
});

const FeedsPage = () => {
  const queryClient = useQueryClient();
  const { data: feeds = [] } = useQuery({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const [active, setActive] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testLoading, setTestLoading] = useState(false);

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      url: '',
      type: 'rss',
      active: true,
      fetch_interval: 900
    }
  });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        url: active.url,
        type: active.type,
        active: Boolean(active.active),
        fetch_interval: active.fetch_interval || 900
      });
      setTestResult(null);
    }
  }, [active, form]);

  const saveFeed = useMutation({
    mutationFn: (payload) =>
      active ? api.put(`/api/feeds/${active.id}`, payload) : api.post('/api/feeds', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
      setActive(null);
      setTestResult(null);
      form.reset();
    },
    onError: (error) => alert(`Failed to save feed: ${error?.message || 'Unknown error'}`)
  });

  const deleteFeed = useMutation({
    mutationFn: (id) => api.delete(`/api/feeds/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
    },
    onError: (error) => alert(`Failed to delete feed: ${error?.message || 'Unknown error'}`)
  });

  const refreshFeed = useMutation({
    mutationFn: (id) => api.post(`/api/feeds/${id}/refresh`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feed-items'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (error) => alert(`Failed to refresh feed: ${error?.message || 'Unknown error'}`)
  });

  const testFeedUrl = async () => {
    const url = form.getValues('url');
    const type = form.getValues('type');
    if (!url) return;
    
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await api.post('/api/feeds/test', { url, type });
      setTestResult(result);
      if (!form.getValues('name') && result.feedTitle) {
        form.setValue('name', result.feedTitle);
      }
    } catch (error) {
      setTestResult({ error: error.message || 'Failed to test feed' });
    }
    setTestLoading(false);
  };

  const onSubmit = (values) => {
    const payload = {
      name: values.name,
      url: values.url,
      type: values.type,
      active: values.active,
      fetch_interval: values.fetch_interval
    };
    saveFeed.mutate(payload);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Feeds</h1>
        <p className="text-muted-foreground">Add RSS, Atom, or JSON feeds. Variables are automatically detected.</p>
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
                    <Input 
                      id="url"
                      {...form.register('url')} 
                      placeholder="https://example.com/feed" 
                      className="flex-1"
                    />
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={testFeedUrl}
                      disabled={testLoading || !form.watch('url')}
                    >
                      {testLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <TestTube className="mr-2 h-4 w-4" />
                      )}
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
                    <Label htmlFor="type">Type</Label>
                    <Select id="type" {...form.register('type')}>
                      <option value="rss">RSS / Atom</option>
                      <option value="json">JSON Feed</option>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="fetch_interval">Check every (seconds)</Label>
                    <Input 
                      id="fetch_interval"
                      type="number" 
                      {...form.register('fetch_interval', { valueAsNumber: true })} 
                      min={300} 
                      step={60} 
                    />
                  </div>
                  <Controller
                    control={form.control}
                    name="active"
                    render={({ field }) => (
                      <div className="flex items-center gap-2 pt-8">
                        <Checkbox 
                          id="active"
                          checked={field.value} 
                          onChange={(e) => field.onChange(e.target.checked)} 
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
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={() => { setActive(null); setTestResult(null); form.reset(); }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Test Results */}
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
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Feed Title</p>
                        <p className="text-sm">{testResult.feedTitle || 'Unknown'}</p>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-muted-foreground">Items Found</p>
                        <p className="text-sm">{testResult.itemCount || 0} items</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-muted-foreground mb-2">
                        Detected Variables (use in templates)
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {(testResult.detectedFields || []).map((field) => (
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

        {/* Saved Feeds */}
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
                    </div>
                    <Badge variant={feed.active ? 'success' : 'secondary'}>
                      {feed.active ? 'Active' : 'Paused'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setActive(feed)}>
                      <Pencil className="mr-1 h-3 w-3" /> Edit
                    </Button>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      onClick={() => refreshFeed.mutate(feed.id)}
                      disabled={refreshFeed.isPending}
                    >
                      <RefreshCw className={`mr-1 h-3 w-3 ${refreshFeed.isPending ? 'animate-spin' : ''}`} />
                      Fetch
                    </Button>
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      onClick={() => deleteFeed.mutate(feed.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
              {feeds.length === 0 && (
                <p className="text-center text-muted-foreground py-8">
                  No feeds yet. Add a feed URL to get started.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default FeedsPage;
