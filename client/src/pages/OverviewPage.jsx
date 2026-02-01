import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';
import { Rss, Layers, Target, CalendarClock, ArrowRight, CheckCircle, AlertCircle, Clock } from 'lucide-react';

const OverviewPage = () => {
  const { data: status } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 5000
  });
  const { data: feeds = [] } = useQuery({ queryKey: ['feeds'], queryFn: () => api.get('/api/feeds') });
  const { data: templates = [] } = useQuery({ queryKey: ['templates'], queryFn: () => api.get('/api/templates') });
  const { data: targets = [] } = useQuery({ queryKey: ['targets'], queryFn: () => api.get('/api/targets') });
  const { data: schedules = [] } = useQuery({ queryKey: ['schedules'], queryFn: () => api.get('/api/schedules') });
  const { data: logs = [] } = useQuery({ queryKey: ['logs'], queryFn: () => api.get('/api/logs') });

  const stats = [
    { label: 'Feeds', value: feeds.length, to: '/feeds', icon: Rss, color: 'text-blue-500' },
    { label: 'Templates', value: templates.length, to: '/templates', icon: Layers, color: 'text-purple-500' },
    { label: 'Targets', value: targets.length, to: '/targets', icon: Target, color: 'text-green-500' },
    { label: 'Schedules', value: schedules.length, to: '/schedules', icon: CalendarClock, color: 'text-orange-500' }
  ];

  const statusVariant = status?.status === 'connected' ? 'success' : (status?.status === 'qr' || status?.status === 'qr_ready' || status?.status === 'connecting') ? 'warning' : 'destructive';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground">Monitor the automation pipeline and WhatsApp connection.</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/whatsapp">
            Open WhatsApp Console
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((item) => {
          const Icon = item.icon;
          return (
            <Card key={item.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{item.label}</CardTitle>
                <Icon className={`h-4 w-4 ${item.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{item.value}</div>
                <Link to={item.to} className="text-xs text-muted-foreground hover:text-primary">
                  View all
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* WhatsApp Status and Recent Activity */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>WhatsApp Connection</CardTitle>
              <Badge variant={statusVariant}>{status?.status || 'unknown'}</Badge>
            </div>
            <CardDescription>Current connection state and recent activity</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className={`flex h-12 w-12 items-center justify-center rounded-full ${
                status?.status === 'connected' ? 'bg-green-100' : 'bg-muted'
              }`}>
                {status?.status === 'connected' ? (
                  <CheckCircle className="h-6 w-6 text-green-600" />
                ) : (
                  <AlertCircle className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
              <div>
                <p className="font-medium">
                  {status?.status === 'connected' ? 'Connected' :
                   (status?.status === 'qr' || status?.status === 'qr_ready') ? 'Waiting for QR scan' :
                   status?.status === 'connecting' ? 'Connecting...' :
                   'Disconnected'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {status?.lastError || 'No recent errors'}
                </p>
              </div>
            </div>
            <Button asChild variant="outline" className="w-full">
              <Link to="/whatsapp">Manage Connection</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Common tasks and shortcuts</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Button asChild variant="outline" className="justify-start">
              <Link to="/feeds">
                <Rss className="mr-2 h-4 w-4" />
                Add New Feed
              </Link>
            </Button>
            <Button asChild variant="outline" className="justify-start">
              <Link to="/templates">
                <Layers className="mr-2 h-4 w-4" />
                Create Template
              </Link>
            </Button>
            <Button asChild variant="outline" className="justify-start">
              <Link to="/schedules">
                <CalendarClock className="mr-2 h-4 w-4" />
                Setup Schedule
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Recent Logs */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Delivery Logs</CardTitle>
          <CardDescription>Latest message delivery attempts</CardDescription>
        </CardHeader>
        <CardContent>
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
                    <Badge variant={log.status === 'sent' ? 'success' : log.status === 'failed' ? 'destructive' : 'warning'}>
                      {log.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">{log.target?.name || log.target_id}</TableCell>
                  <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                    {log.message_content?.substring(0, 50) || '—'}
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
          {logs.length > 5 && (
            <div className="mt-4 text-center">
              <Button asChild variant="outline" size="sm">
                <Link to="/logs">View All Logs</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default OverviewPage;
