import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import { Checkbox } from '../components/ui/checkbox';
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
  const [includeManual, setIncludeManual] = useState(false);
  const [scheduleId, setScheduleId] = useState('all');
  const [targetId, setTargetId] = useState('all');
  const [verifyDelivery, setVerifyDelivery] = useState(false);

  const { data: schedules = [] } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => api.get('/api/schedules')
  });

  const { data: targets = [] } = useQuery({
    queryKey: ['targets'],
    queryFn: () => api.get('/api/targets')
  });

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['logs', status, includeManual, scheduleId, targetId, verifyDelivery],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (scheduleId !== 'all') params.set('schedule_id', scheduleId);
      if (targetId !== 'all') params.set('target_id', targetId);
      if (verifyDelivery) params.set('verify_delivery', 'true');
      if (includeManual) params.set('include_manual', 'true');
      const query = params.toString();
      return api.get(query ? `/api/logs?${query}` : '/api/logs');
    },
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
              <CardDescription>
                {logs.length} log{logs.length !== 1 ? 's' : ''}
                {!includeManual && ' (automation sends only)'}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={includeManual} onCheckedChange={(checked) => setIncludeManual(checked === true)} />
                Include manual/test sends
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={verifyDelivery} onCheckedChange={(checked) => setVerifyDelivery(checked === true)} />
                Verify against WhatsApp outbox
              </label>
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
              <Select value={scheduleId} onValueChange={setScheduleId}>
                <SelectTrigger className="w-52">
                  <SelectValue placeholder="All schedules" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All schedules</SelectItem>
                  {schedules.map((schedule) => (
                    <SelectItem key={schedule.id} value={schedule.id}>
                      {schedule.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="All targets" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All targets</SelectItem>
                  {targets.map((target) => (
                    <SelectItem key={target.id} value={target.id}>
                      {target.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
                  <TableHeaderCell className="hidden lg:table-cell">Observed</TableHeaderCell>
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
                    <TableCell className="hidden lg:table-cell">
                      {verifyDelivery && log.whatsapp_message_id ? (
                        <Badge variant={log.delivery_observed ? 'success' : 'warning'}>
                          {log.delivery_observed ? 'Seen' : 'Not seen'}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(log.sent_at || log.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
                {logs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
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
