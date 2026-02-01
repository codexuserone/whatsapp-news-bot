import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';

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
    }
  });

  const deleteFeed = useMutation({
    mutationFn: (id) => api.delete(`/api/feeds/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feeds'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
    }
  });

  const refreshFeed = useMutation({
    mutationFn: (id) => api.post(`/api/feeds/${id}/refresh`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feed-items'] });
      queryClient.invalidateQueries({ queryKey: ['available-variables'] });
    }
  });

  // Test feed URL and show detected fields
  const testFeedUrl = async () => {
    const url = form.getValues('url');
    const type = form.getValues('type');
    if (!url) return;
    
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await api.post('/api/feeds/test', { url, type });
      setTestResult(result);
      // Auto-fill name if empty
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
    <div className="space-y-8">
      <PageHeader title="Feeds" subtitle="Add RSS, Atom, or JSON feeds. Variables are automatically detected." />

      <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{active ? 'Edit Feed' : 'Add Feed'}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Feed URL</label>
                  <div className="flex gap-2">
                    <Input 
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
                      {testLoading ? 'Testing...' : 'Test'}
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Name</label>
                    <Input {...form.register('name')} placeholder="Auto-detected from feed" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Type</label>
                    <Select {...form.register('type')}>
                      <option value="rss">RSS / Atom</option>
                      <option value="json">JSON Feed</option>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Check every (seconds)</label>
                    <Input type="number" {...form.register('fetch_interval', { valueAsNumber: true })} min={300} step={60} />
                  </div>
                  <Controller
                    control={form.control}
                    name="active"
                    render={({ field }) => (
                      <label className="flex items-center gap-2 text-sm font-medium pt-6">
                        <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
                        Active
                      </label>
                    )}
                  />
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  <Button type="submit" disabled={saveFeed.isPending}>
                    {saveFeed.isPending ? 'Saving...' : active ? 'Update Feed' : 'Save Feed'}
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

          {/* Test Results */}
          {testResult && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Feed Test Result
                  {testResult.error ? (
                    <Badge variant="danger">Error</Badge>
                  ) : (
                    <Badge variant="success">Valid</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {testResult.error ? (
                  <p className="text-sm text-red-600">{testResult.error}</p>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <p className="text-sm font-medium text-ink/70">Feed Title</p>
                      <p className="text-sm">{testResult.feedTitle || 'Unknown'}</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-ink/70">Items Found</p>
                      <p className="text-sm">{testResult.itemCount || 0} items</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-ink/70 mb-2">Detected Variables (available in templates)</p>
                      <div className="flex flex-wrap gap-2">
                        {(testResult.detectedFields || []).map((field) => (
                          <span
                            key={field}
                            className="rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-700"
                          >
                            {`{{${field}}}`}
                          </span>
                        ))}
                      </div>
                    </div>
                    {testResult.sampleItem && (
                      <div>
                        <p className="text-sm font-medium text-ink/70 mb-2">Sample Item</p>
                        <div className="rounded-lg border border-ink/10 bg-white/50 p-3 space-y-1">
                          {Object.entries(testResult.sampleItem).map(([key, value]) => (
                            <div key={key} className="text-xs">
                              <span className="font-medium text-sky-700">{key}:</span>{' '}
                              <span className="text-ink/70">{String(value || '').slice(0, 100)}{String(value || '').length > 100 ? '...' : ''}</span>
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
            <CardTitle>Saved Feeds ({feeds.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {feeds.map((feed) => (
                <div key={feed.id} className="rounded-lg border border-ink/10 bg-white/50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{feed.name}</p>
                      <p className="text-xs text-ink/50 truncate">{feed.url}</p>
                    </div>
                    <Badge variant={feed.active ? 'success' : 'secondary'}>
                      {feed.active ? 'Active' : 'Paused'}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <Button size="sm" variant="outline" onClick={() => setActive(feed)}>
                      Edit
                    </Button>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      onClick={() => refreshFeed.mutate(feed.id)}
                      disabled={refreshFeed.isPending}
                    >
                      {refreshFeed.isPending ? 'Fetching...' : 'Fetch Now'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteFeed.mutate(feed.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
              {feeds.length === 0 && (
                <p className="text-center text-ink/50 py-4">
                  No feeds yet. Add a feed URL above to get started.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
};

export default FeedsPage;
