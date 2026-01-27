import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';

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
    { label: 'Feeds', value: feeds.length, to: '/feeds' },
    { label: 'Templates', value: templates.length, to: '/templates' },
    { label: 'Targets', value: targets.length, to: '/targets' },
    { label: 'Schedules', value: schedules.length, to: '/schedules' }
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Overview"
        subtitle="Monitor the automation pipeline and WhatsApp connection health."
        actions={
          <Link
            to="/whatsapp"
            className="rounded-full border border-ink/20 px-4 py-2 text-sm font-semibold text-ink hover:bg-ink/5"
          >
            Open WhatsApp Console
          </Link>
        }
      />

      <section className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp Connection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm text-ink/60">Current state</p>
                <p className="text-lg font-semibold text-ink">{status?.status || 'unknown'}</p>
              </div>
              <Badge variant={status?.status === 'connected' ? 'success' : status?.status === 'qr' ? 'warning' : 'danger'}>
                {status?.status || 'offline'}
              </Badge>
            </div>
            <p className="text-sm text-ink/60">
              {status?.lastError ? `Last error: ${status.lastError}` : 'No recent connection errors.'}
            </p>
            <Link to="/whatsapp" className="text-sm font-semibold text-brand hover:text-brand-dark">
              Manage QR + connection
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Automation Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {stats.map((item) => (
              <Link
                key={item.label}
                to={item.to}
                className="flex items-center justify-between rounded-2xl border border-ink/10 bg-white/70 px-4 py-3 text-sm text-ink hover:bg-ink/5"
              >
                <span>{item.label}</span>
                <span className="text-base font-semibold">{item.value}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Latest Delivery Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Target</TableHeaderCell>
                <TableHeaderCell>Feed Item</TableHeaderCell>
                <TableHeaderCell>Timestamp</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {logs.slice(0, 5).map((log) => (
                <TableRow key={log._id}>
                  <TableCell className="capitalize">{log.status}</TableCell>
                  <TableCell>{log.targetId}</TableCell>
                  <TableCell>{log.feedItemId}</TableCell>
                  <TableCell>{new Date(log.sentAt || log.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {logs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-ink/50">
                    No logs yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
};

export default OverviewPage;
