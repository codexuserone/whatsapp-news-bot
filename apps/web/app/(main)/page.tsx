'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Feed, LogEntry, QueueStats, Schedule, Target, Template } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '@/components/ui/table';
import { Rss, Layers, Target as TargetIcon, CalendarClock, ArrowRight } from 'lucide-react';

type DeliveryAnalytics = {
  window_hours?: number;
  window_start?: string;
  sent: number;
  delivered: number;
  read: number;
  played: number;
  failed: number;
  skipped: number;
  delivered_rate: number;
  read_rate: number;
  played_rate: number;
};

const OverviewPage = () => {
  const { data: feeds = [] } = useQuery<Feed[]>({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const { data: templates = [] } = useQuery<Template[]>({ queryKey: ['templates'], queryFn: () => api.get('/api/templates') });
  const { data: targets = [] } = useQuery<Target[]>({ queryKey: ['targets'], queryFn: () => api.get('/api/targets?sync=true') });
  const { data: schedules = [] } = useQuery<Schedule[]>({ queryKey: ['schedules'], queryFn: () => api.get('/api/schedules') });
  const { data: logs = [] } = useQuery<LogEntry[]>({ queryKey: ['logs'], queryFn: () => api.get('/api/logs') });
  const { data: queueStats } = useQuery<QueueStats>({
    queryKey: ['queue-stats'],
    queryFn: () => api.get('/api/queue/stats?window_hours=24'),
    refetchInterval: 30000
  });
  const { data: deliveryAnalytics } = useQuery<DeliveryAnalytics>({
    queryKey: ['delivery-analytics'],
    queryFn: () => api.get('/api/analytics/delivery?window_hours=24'),
    refetchInterval: 30000
  });

  const stats = [
    { label: 'Feeds', value: feeds.length, to: '/feeds', icon: Rss, color: 'text-primary' },
    { label: 'Templates', value: templates.length, to: '/templates', icon: Layers, color: 'text-amber-500' },
    { label: 'Destinations', value: targets.length, to: '/targets', icon: TargetIcon, color: 'text-emerald-500' },
    { label: 'Schedules', value: schedules.length, to: '/schedules', icon: CalendarClock, color: 'text-sky-500' }
  ];

  const feedErrors = feeds.filter((feed) => feed.last_error).length;
  const liveQueuedNow = Number(queueStats?.queued_now ?? ((queueStats?.awaiting_approval ?? 0) + (queueStats?.pending ?? 0) + (queueStats?.processing ?? 0)));
  const recentRecordedCount = Number(deliveryAnalytics?.sent ?? 0);
  const recentFailedCount = Number(queueStats?.failed ?? 0);
  const recentSkippedCount = Number(queueStats?.skipped ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground">Monitor feeds, schedules, queue, and WhatsApp connection.</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/whatsapp">
            Open WhatsApp
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((item, index) => {
          const Icon = item.icon;
          return (
            <Card
              key={item.label}
              className="animate-in fade-in-0 slide-in-from-bottom-2 duration-500"
              style={{ animationDelay: `${index * 70}ms` }}
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{item.label}</CardTitle>
                <Icon className={`h-4 w-4 ${item.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{item.value}</div>
                <Link href={item.to} className="text-xs text-muted-foreground hover:text-primary">
                  View all
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Button asChild variant="outline" className="justify-start">
              <Link href="/feeds">
                <Rss className="mr-2 h-4 w-4" />
                Add New Feed
              </Link>
            </Button>
            <Button asChild variant="outline" className="justify-start">
              <Link href="/templates">
                <Layers className="mr-2 h-4 w-4" />
                Create Template
              </Link>
            </Button>
            <Button asChild variant="outline" className="justify-start">
              <Link href="/schedules">
                <CalendarClock className="mr-2 h-4 w-4" />
                Create Schedule
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Queue Summary</CardTitle>
            <CardDescription>Live queue right now, plus recent app-recorded send results.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Live now</div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total waiting now</span>
              <span className="font-medium">{liveQueuedNow}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Awaiting approval</span>
              <span className="font-medium">{queueStats?.awaiting_approval ?? 0}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Queued</span>
              <span className="font-medium">{queueStats?.pending ?? 0}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Trying now</span>
              <span className="font-medium">{queueStats?.processing ?? 0}</span>
            </div>
            <div className="border-t pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Last {queueStats?.window_hours ?? 24} hours</div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Sent with WhatsApp id</span>
              <span className="font-medium">{recentRecordedCount}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Failed</span>
              <span className="font-medium">{recentFailedCount}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Skipped</span>
              <span className="font-medium">{recentSkippedCount}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {feedErrors > 0
                ? `${feedErrors} feed error${feedErrors !== 1 ? 's' : ''} need attention`
                : 'No feed errors'}
            </div>
            <Button asChild variant="outline" size="sm" className="w-full">
              <Link href="/queue">View Queue</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Delivery Logs</CardTitle>
          <CardDescription>Latest message delivery attempts</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Target</TableHeaderCell>
                  <TableHeaderCell className="hidden md:table-cell">Message</TableHeaderCell>
                  <TableHeaderCell>Time</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.slice(0, 5).map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      <Badge
                        variant={
                          ['sent', 'delivered', 'read', 'played'].includes(String(log.status || '').toLowerCase())
                            ? 'success'
                            : log.status === 'failed'
                              ? 'destructive'
                              : 'warning'
                        }
                      >
                        {['sent', 'delivered', 'read', 'played'].includes(String(log.status || '').toLowerCase()) ? 'Sent' : log.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">{log.target?.name || log.target_id}</TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                      {log.message_content?.substring(0, 50) || '-'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(log.sent_at || log.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
                {logs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                      No delivery logs yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {logs.length > 5 && (
            <div className="mt-4 text-center">
              <Button asChild variant="outline" size="sm">
                <Link href="/logs">View All Logs</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div >
  );
};

export default OverviewPage;
