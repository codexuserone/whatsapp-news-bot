import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { ClipboardList, ExternalLink, Loader2 } from 'lucide-react';

const STATUS_VARIANTS = {
  queued: 'warning',
  sent: 'success',
  failed: 'destructive',
  not_queued: 'secondary'
};

const STATUS_LABELS = {
  queued: 'Pending',
  sent: 'Sent',
  failed: 'Failed',
  not_queued: 'New'
};

const getDeliveryMeta = (item) => {
  const status = item?.delivery_status || (item?.sent ? 'sent' : 'not_queued');
  return {
    status,
    label: STATUS_LABELS[status] || 'Unknown'
  };
};

const formatDeliverySummary = (delivery, deliveryStatus) => {
  const data = delivery || {};
  const sent = Number(data.sent || 0);
  const failed = Number(data.failed || 0);
  
  // Simple, clear messages
  if (deliveryStatus === 'sent' && sent > 0) {
    return `Delivered to ${sent} target${sent !== 1 ? 's' : ''}`;
  }
  if (failed > 0) {
    return `Failed: ${failed}`;
  }
  if (deliveryStatus === 'sent') {
    return 'Delivered';
  }
  // Don't show confusing "No delivery logs" - just leave blank for unqueued items
  return '';
};

const FeedItemsPage = () => {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['feed-items'],
    queryFn: () => api.get('/api/feed-items'),
    refetchInterval: 15000
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Feed Items</h1>
        <p className="text-muted-foreground">Recently ingested feed entries available for dispatch.</p>
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
                {items.map((item) => {
                  const deliveryMeta = getDeliveryMeta(item);
                  const summary = formatDeliverySummary(item.delivery, deliveryMeta.status);
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="max-w-xs truncate font-medium" title={item.title}>
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
                        ) : '—'}
                      </TableCell>
                      <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                        {item.image_url ? (
                          <a
                            href={item.image_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2"
                          >
                            <img
                              src={item.image_url}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              className="h-10 w-10 shrink-0 rounded border bg-muted object-cover"
                            />
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
                        <Badge variant={STATUS_VARIANTS[deliveryMeta.status] || 'secondary'}>
                          {deliveryMeta.label}
                        </Badge>
                        <div className="text-xs text-muted-foreground mt-1">{summary}</div>
                      </TableCell>
                    </TableRow>
                  );
                })}
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
