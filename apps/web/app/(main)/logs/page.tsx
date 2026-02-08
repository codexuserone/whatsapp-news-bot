'use client';

import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { LogEntry, WhatsAppOutbox, WhatsAppOutboxStatus } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '@/components/ui/table';
import { Activity, Loader2 } from 'lucide-react';

const STATUS_COLORS: Record<string, 'success' | 'destructive' | 'warning' | 'secondary'> = {
  pending: 'warning',
  processing: 'secondary',
  sent: 'success',
  delivered: 'success',
  read: 'success',
  skipped: 'warning',
  failed: 'destructive'
};

const mapMessageStatusLabel = (status?: number | null, statusLabel?: string | null) => {
  if (statusLabel) return statusLabel;
  switch (status) {
    case 0:
      return 'error';
    case 1:
      return 'pending';
    case 2:
      return 'server';
    case 3:
      return 'delivered';
    case 4:
      return 'read';
    case 5:
      return 'played';
    default:
      return null;
  }
};

const LogsPage = () => {
  const [status, setStatus] = useState('all');
  const { data: logs = [], isLoading } = useQuery<LogEntry[]>({
    queryKey: ['logs', status],
    queryFn: () => api.get(status === 'all' ? '/api/logs' : `/api/logs?status=${status}`),
    refetchInterval: 10000
  });

  const { data: outbox } = useQuery<WhatsAppOutbox>({
    queryKey: ['whatsapp-outbox'],
    queryFn: () => api.get('/api/whatsapp/outbox'),
    refetchInterval: 5000
  });

  const statusByMessageId = useMemo(() => {
    const map = new Map<string, WhatsAppOutboxStatus>();
    for (const snap of outbox?.statuses || []) {
      if (!snap?.id) continue;
      map.set(String(snap.id), snap);
    }
    return map;
  }, [outbox?.statuses]);

  const getReceiptBadge = (log: LogEntry) => {
    const messageId = String(log.whatsapp_message_id || '').trim();
    if (!messageId) {
      if (log.status === 'sent') {
        return <Badge variant="warning">Receipt unknown</Badge>;
      }
      return <Badge variant="secondary">—</Badge>;
    }

    const snap = statusByMessageId.get(messageId);
    if (!snap) {
      return <Badge variant="warning">Not observed</Badge>;
    }

    const label = mapMessageStatusLabel(snap.status, snap.statusLabel);
    if (!label) {
      return <Badge variant="secondary">Observed</Badge>;
    }

    const lower = label.toLowerCase();
    if (lower === 'error') return <Badge variant="destructive">{label}</Badge>;
    if (lower === 'delivered' || lower === 'read' || lower === 'played') return <Badge variant="success">{label}</Badge>;
    if (lower === 'pending' || lower === 'server') return <Badge variant="warning">{label}</Badge>;
    return <Badge variant="secondary">{label}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Logs</h1>
        <p className="text-muted-foreground">
          Delivery history after sending. Queue shows editable pending messages; logs show what already happened.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Use the <span className="font-medium">WhatsApp</span> column for real-time receipt evidence (server/delivered/read), not just internal status.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Delivery Logs
              </CardTitle>
              <CardDescription>{logs.length} log{logs.length !== 1 ? 's' : ''}</CardDescription>
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="delivered">Delivered</SelectItem>
                <SelectItem value="read">Read</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="skipped">Skipped</SelectItem>
              </SelectContent>
            </Select>
          </div>
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
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Target</TableHeaderCell>
                  <TableHeaderCell className="hidden md:table-cell">Schedule</TableHeaderCell>
                  <TableHeaderCell className="hidden md:table-cell">WhatsApp</TableHeaderCell>
                  <TableHeaderCell className="hidden lg:table-cell">Media</TableHeaderCell>
                  <TableHeaderCell className="hidden lg:table-cell">Message</TableHeaderCell>
                  <TableHeaderCell>Time</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      <Badge
                        variant={STATUS_COLORS[log.status] || 'secondary'}
                        title={log.error_message || undefined}
                      >
                        {log.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">{log.target?.name || log.target_id}</TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {log.schedule?.name || log.schedule_id || '—'}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {getReceiptBadge(log)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {log.media_type ? (
                        <Badge
                          variant={log.media_sent ? 'success' : log.media_error ? 'destructive' : 'secondary'}
                          title={log.media_error || log.media_url || undefined}
                        >
                          {log.media_type}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell
                      className="hidden max-w-xs truncate text-muted-foreground lg:table-cell"
                      title={log.message_content || undefined}
                    >
                      {log.message_content?.substring(0, 50) || '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(log.sent_at || log.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
                {logs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      No logs found.
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

export default LogsPage;
