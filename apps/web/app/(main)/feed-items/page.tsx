'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { FeedItem } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClipboardList, ExternalLink, Loader2, PauseCircle, PlayCircle, PenSquare } from 'lucide-react';

const buildComposeHref = (item: FeedItem) => {
  const params = new URLSearchParams();
  const title = String(item.title || '').trim();
  const url = String(item.link || '').trim();
  const imageUrl = String(item.image_url || '').trim();
  if (title) params.set('title', title);
  if (url) params.set('url', url);
  if (imageUrl) params.set('imageUrl', imageUrl);
  const query = params.toString();
  return query ? `/compose?${query}` : '/compose';
};

const FeedItemsPage = () => {
  const queryClient = useQueryClient();
  const [scope, setScope] = React.useState<'automation' | 'all'>('automation');
  const { data: items = [], isLoading } = useQuery<FeedItem[]>({
    queryKey: ['feed-items', scope],
    queryFn: () => api.get(`/api/feed-items?scope=${scope}`),
    refetchInterval: 15000
  });

  const pausePost = useMutation({
    mutationFn: (id: string) => api.post(`/api/feed-items/${id}/pause`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feed-items'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['logs'] });
    }
  });

  const resumePost = useMutation({
    mutationFn: (id: string) => api.post(`/api/feed-items/${id}/resume`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feed-items'] });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['logs'] });
    }
  });

  const getStatus = (item: FeedItem) => {
    if (item.delivery_status === 'no_automation') {
      return { label: 'No active automation', variant: 'secondary' as const };
    }
    if (item.delivery_status === 'automation_incomplete') {
      return { label: 'Automation setup incomplete', variant: 'warning' as const };
    }
    if (item.delivery_status === 'not_queued') {
      return { label: 'Will queue on next poll', variant: 'secondary' as const };
    }
    if (item.delivery_status === 'not_queued_old') {
      return { label: 'Older than queue start', variant: 'secondary' as const };
    }

    const delivery = item.delivery || {
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      manual_paused: 0,
      total: 0
    };
    const queued = (delivery.pending || 0) + (delivery.processing || 0);
    const sent = delivery.sent || 0;
    const failed = delivery.failed || 0;
    const manualPaused = delivery.manual_paused || 0;
    const total = delivery.total || 0;

    if (manualPaused > 0 && queued > 0) {
      return { label: `Paused (${manualPaused}), queued (${queued})`, variant: 'warning' as const };
    }
    if (manualPaused > 0) {
      return { label: `Paused (${manualPaused})`, variant: 'secondary' as const };
    }

    if (queued > 0 && sent > 0 && failed > 0) {
      return { label: `Mixed (${sent} sent, ${queued} queued, ${failed} failed)`, variant: 'warning' as const };
    }
    if (queued > 0 && sent > 0) {
      return { label: `Partially sent (${sent} sent, ${queued} queued)`, variant: 'warning' as const };
    }
    if (queued > 0 && failed > 0) {
      return { label: `Retrying (${queued} queued, ${failed} failed)`, variant: 'warning' as const };
    }
    if (queued > 0) {
      return { label: `Queued (${queued})`, variant: 'warning' as const };
    }
    if (sent > 0 && failed > 0) {
      return { label: `Partial (${sent} sent, ${failed} failed)`, variant: 'warning' as const };
    }
    if (failed > 0) {
      return { label: `Failed (${failed})`, variant: 'destructive' as const };
    }
    if (sent > 0) {
      return { label: `Sent (${sent})`, variant: 'success' as const };
    }
    // Item exists in feed history but no queue rows were created yet.
    if (total === 0) {
      return { label: 'Waiting for next send window', variant: 'secondary' as const };
    }
    return { label: 'Waiting', variant: 'secondary' as const };
  };

  const isStoryPaused = (item: FeedItem) => {
    const manualPaused = Number(item.delivery?.manual_paused || 0);
    if (manualPaused > 0) return true;
    return item.delivery_status === 'paused' || item.delivery_status === 'paused_with_queue';
  };

  const formatPublishedAt = (pubDate?: string | null, rawData?: Record<string, unknown> | null) => {
    if (!pubDate) return '-';
    const parsed = new Date(pubDate);
    if (!Number.isFinite(parsed.getTime())) return '-';
    const precision = String(rawData?.published_precision || '').toLowerCase();
    const dateOnlyByValue = /t00:00(?::00(?:\.\d+)?)?(?:z|[+-]\d{2}:\d{2})$/i.test(String(pubDate));
    if (precision === 'date' || (!precision && dateOnlyByValue)) {
      return `${parsed.toLocaleDateString()} (date only from source)`;
    }
    return parsed.toLocaleString();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Feed Items</h1>
        <p className="text-muted-foreground">
          Stories from your feeds. Queue is where editable outgoing messages live before they are sent.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5" />
                Latest Items
              </CardTitle>
              <CardDescription>{items.length} item{items.length !== 1 ? 's' : ''} fetched</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={scope === 'automation' ? 'default' : 'outline'}
                onClick={() => setScope('automation')}
              >
                In automations
              </Button>
              <Button
                size="sm"
                variant={scope === 'all' ? 'default' : 'outline'}
                onClick={() => setScope('all')}
              >
                All feeds
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Title</TableHeaderCell>
                    <TableHeaderCell className="hidden sm:table-cell">Feed</TableHeaderCell>
                    <TableHeaderCell className="hidden md:table-cell">Link</TableHeaderCell>
                  <TableHeaderCell className="hidden md:table-cell">Image</TableHeaderCell>
                  <TableHeaderCell className="hidden lg:table-cell">Published</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell className="text-right">Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const paused = isStoryPaused(item);
                    return (
                    <TableRow key={item.id}>
                      <TableCell className="max-w-xs truncate font-medium" title={item.title || undefined}>
                        {item.title || 'Untitled'}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="secondary">{item.feed?.name || 'Unknown'}</Badge>
                      </TableCell>
                      <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                        {item.link ? (
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-primary hover:underline"
                          >
                            <ExternalLink className="h-3 w-3" />
                            Link
                          </a>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                        {item.image_url ? (
                          <a
                            href={item.image_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2"
                          >
                            <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded border bg-muted">
                              <Image
                                src={item.image_url}
                                alt=""
                                fill
                                sizes="40px"
                                className="object-cover"
                                unoptimized
                              />
                            </span>
                            <span className="flex items-center gap-1 text-primary hover:underline">
                              <ExternalLink className="h-3 w-3" />
                              Image
                            </span>
                          </a>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">
                        {formatPublishedAt(item.pub_date, item.raw_data)}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const status = getStatus(item);
                          return <Badge variant={status.variant}>{status.label}</Badge>;
                        })()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Button size="sm" variant="outline" asChild title="Compose from story">
                            <Link href={buildComposeHref(item)}>
                              <PenSquare className="mr-1 h-3 w-3" />
                              <span className="hidden md:inline">Compose</span>
                              <span className="md:hidden sr-only">Compose</span>
                            </Link>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => (paused ? resumePost.mutate(item.id) : pausePost.mutate(item.id))}
                            disabled={pausePost.isPending || resumePost.isPending}
                          >
                            {paused ? <PlayCircle className="mr-1 h-3 w-3" /> : <PauseCircle className="mr-1 h-3 w-3" />}
                            <span className="hidden md:inline">{paused ? 'Resume story' : 'Pause story'}</span>
                            <span className="md:hidden sr-only">{paused ? 'Resume story' : 'Pause story'}</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )})}
                  {items.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                        No feed items found for this filter.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default FeedItemsPage;
