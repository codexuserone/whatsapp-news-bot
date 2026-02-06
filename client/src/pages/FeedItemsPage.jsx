import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
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

  const { data: schedules = [] } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => api.get('/api/schedules')
  });

  const { data: targets = [] } = useQuery({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const activeTargetIds = new Set(targets.filter((target) => target.active).map((target) => target.id));
  const feedsWithAutomation = new Set(
    schedules
      .filter(
        (schedule) =>
          schedule.active &&
          Array.isArray(schedule.target_ids) &&
          schedule.target_ids.some((targetId) => activeTargetIds.has(targetId))
      )
      .map((schedule) => schedule.feed_id)
      .filter(Boolean)
  );

  const unroutedFeedCounts = items.reduce((acc, item) => {
    if (item.delivery_status !== 'not_queued') return acc;
    const feedId = item.feed_id;
    if (!feedId || feedsWithAutomation.has(feedId)) return acc;
    const key = String(feedId);
    const current = acc.get(key) || { feedId, feedName: item.feed?.name || 'Unknown feed', count: 0 };
    current.count += 1;
    acc.set(key, current);
    return acc;
  }, new Map());

  const unroutedFeeds = Array.from(unroutedFeedCounts.values()).sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Feed Items</h1>
        <p className="text-muted-foreground">Recently ingested feed entries available for dispatch.</p>
      </div>

      {unroutedFeeds.length > 0 && (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader>
            <CardTitle className="text-lg">Unrouted Feed Items Detected</CardTitle>
            <CardDescription>
              These feeds have new items but no active automation, so items remain "New" and are never queued.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {unroutedFeeds.slice(0, 4).map((entry) => (
              <div key={entry.feedId} className="flex items-center justify-between rounded-lg border bg-background/70 px-3 py-2">
                <div>
                  <p className="font-medium">{entry.feedName}</p>
                  <p className="text-xs text-muted-foreground">{entry.count} item{entry.count !== 1 ? 's' : ''} waiting</p>
                </div>
                <Button size="sm" asChild>
                  <Link to={`/schedules?feed_id=${entry.feedId}`}>Add Automation</Link>
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

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
                  const missingAutomation =
                    deliveryMeta.status === 'not_queued' && item.feed_id && !feedsWithAutomation.has(item.feed_id);
                  const summary = missingAutomation
                    ? 'No active automation for this feed'
                    : formatDeliverySummary(item.delivery, deliveryMeta.status);
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
