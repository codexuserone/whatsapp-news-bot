'use client';

import React from 'react';
import Image from 'next/image';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { FeedItem } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClipboardList, ExternalLink, Loader2, PauseCircle, PlayCircle } from 'lucide-react';

const FeedItemsPage = () => {
  const queryClient = useQueryClient();
  const { data: items = [], isLoading } = useQuery<FeedItem[]>({
    queryKey: ['feed-items'],
    queryFn: () => api.get('/api/feed-items'),
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
    // Show clearer status when not yet queued
    if (total === 0) {
      return { label: 'New - will send soon', variant: 'secondary' as const };
    }
    return { label: 'Waiting', variant: 'secondary' as const };
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Feed Items</h1>
        <p className="text-muted-foreground">
          Raw stories fetched from feeds (sorted by publish time). Queue is where editable outgoing messages live before they are sent.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5" />
            Latest Items
          </CardTitle>
          <CardDescription>{items.length} item{items.length !== 1 ? 's' : ''} fetched</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Title</TableHeaderCell>
                  <TableHeaderCell className="hidden sm:table-cell">Feed</TableHeaderCell>
                  <TableHeaderCell className="hidden md:table-cell">Link</TableHeaderCell>
                  <TableHeaderCell className="hidden md:table-cell">Image</TableHeaderCell>
                  <TableHeaderCell className="hidden lg:table-cell">Published</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell className="hidden lg:table-cell">Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
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
                      {item.pub_date ? new Date(item.pub_date).toLocaleString() : '-'}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const status = getStatus(item);
                        return <Badge variant={status.variant}>{status.label}</Badge>;
                      })()}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => pausePost.mutate(item.id)}
                          disabled={pausePost.isPending || resumePost.isPending}
                        >
                          <PauseCircle className="mr-1 h-3 w-3" />
                          Pause post
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resumePost.mutate(item.id)}
                          disabled={pausePost.isPending || resumePost.isPending}
                        >
                          <PlayCircle className="mr-1 h-3 w-3" />
                          Resume post
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      No feed items yet. Add feeds and refresh them to see items here.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default FeedItemsPage;
