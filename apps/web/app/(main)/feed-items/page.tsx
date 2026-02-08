'use client';

import React from 'react';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { FeedItem } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ClipboardList, ExternalLink, Loader2 } from 'lucide-react';

const FeedItemsPage = () => {
  const { data: items = [], isLoading } = useQuery<FeedItem[]>({
    queryKey: ['feed-items'],
    queryFn: () => api.get('/api/feed-items'),
    refetchInterval: 15000
  });

  const getStatus = (item: FeedItem) => {
    const delivery = item.delivery || {
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      total: 0
    };
    const queued = (delivery.pending || 0) + (delivery.processing || 0);
    if (queued > 0) {
      return { label: `Queued (${queued})`, variant: 'warning' as const };
    }
    if ((delivery.failed || 0) > 0) {
      return { label: `Failed (${delivery.failed})`, variant: 'destructive' as const };
    }
    if ((delivery.sent || 0) > 0) {
      return { label: `Sent (${delivery.sent})`, variant: 'success' as const };
    }
    return { label: 'Not queued', variant: 'secondary' as const };
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Feed Items</h1>
        <p className="text-muted-foreground">
          Raw stories fetched from feeds. Queue is where editable outgoing messages live before they are sent.
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
                        '—'
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
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {item.pub_date ? new Date(item.pub_date).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const status = getStatus(item);
                        return <Badge variant={status.variant}>{status.label}</Badge>;
                      })()}
                    </TableCell>
                  </TableRow>
                ))}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
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
