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
  played: 'success',
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
  const [status, setStatus] = useState('sent');
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
      return null;
    }

    const snap = statusByMessageId.get(messageId);
    if (!snap) {
      return null;
    }

    const label = mapMessageStatusLabel(snap.status, snap.statusLabel);
    if (!label) {
      return null;
    }

    const lower = label.toLowerCase();
    if (lower === 'delivered' || lower === 'read' || lower === 'played') {
      return <Badge variant="success">Delivered</Badge>;
    }
    if (lower === 'error') {
      return <Badge variant="destructive">Failed</Badge>;
    }
    return null;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">History</h1>
        <p className="text-muted-foreground">
          Delivery history only. Use Queue for items that are still waiting or sending.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Sent Messages
              </CardTitle>
              <CardDescription>{logs.length} message{logs.length !== 1 ? 's' : ''}</CardDescription>
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
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
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>To</TableHeaderCell>
                    <TableHeaderCell className="hidden lg:table-cell">Content</TableHeaderCell>
                    <TableHeaderCell>When</TableHeaderCell>
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
                          {log.status === 'sent' ? 'Sent' :
                           log.status === 'failed' ? 'Failed' :
                           log.status === 'pending' ? 'Sending' :
                           log.status === 'delivered' ? 'Delivered' :
                           log.status === 'read' ? 'Read' :
                           log.status === 'played' ? 'Played' :
                           log.status}
                        </Badge>
                        {getReceiptBadge(log)}
                      </TableCell>
                      <TableCell className="font-medium">{log.target?.name || log.target_id}</TableCell>
                      <TableCell
                        className="hidden max-w-xs truncate text-muted-foreground lg:table-cell"
                        title={log.message_content || undefined}
                      >
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
                        No messages sent yet.
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

export default LogsPage;
