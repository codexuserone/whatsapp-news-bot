import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';
import { Activity, Loader2 } from 'lucide-react';

const STATUS_COLORS = {
  sent: 'success',
  delivered: 'success',
  read: 'success',
  failed: 'destructive',
  pending: 'warning',
  skipped: 'warning',
  processing: 'secondary'
};

const LogsPage = () => {
  const [status, setStatus] = useState('all');
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['logs', status],
    queryFn: () => api.get(status === 'all' ? '/api/logs' : `/api/logs?status=${status}`),
    refetchInterval: 10000
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Logs</h1>
        <p className="text-muted-foreground">Inspect sent and failed delivery attempts.</p>
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
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground lg:table-cell" title={log.message_content}>
                      {log.message_content?.substring(0, 50) || '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(log.sent_at || log.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
                {logs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
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
