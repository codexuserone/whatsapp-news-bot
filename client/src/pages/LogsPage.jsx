import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Select } from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';

const STATUS_COLORS = {
  sent: 'success',
  failed: 'danger',
  pending: 'warning'
};

const LogsPage = () => {
  const [status, setStatus] = useState('');
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['logs', status],
    queryFn: () => api.get(status ? `/api/logs?status=${status}` : '/api/logs'),
    refetchInterval: 10000
  });

  return (
    <div className="space-y-8">
      <PageHeader title="Logs" subtitle="Inspect sent and failed delivery attempts." />
      <Card>
        <CardHeader>
          <CardTitle>Delivery Logs ({logs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 max-w-xs">
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="sent">Sent</option>
              <option value="failed">Failed</option>
            </Select>
          </div>
          {isLoading ? (
            <div className="text-center py-8 text-ink/50">Loading logs...</div>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Target</TableHeaderCell>
                  <TableHeaderCell>Schedule</TableHeaderCell>
                  <TableHeaderCell>Message</TableHeaderCell>
                  <TableHeaderCell>Time</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      <Badge variant={STATUS_COLORS[log.status] || 'secondary'} className="capitalize">
                        {log.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{log.target?.name || log.target_id}</TableCell>
                    <TableCell>{log.schedule?.name || log.schedule_id || '—'}</TableCell>
                    <TableCell className="max-w-xs truncate" title={log.message_content}>
                      {log.message_content ? log.message_content.substring(0, 50) + '...' : '—'}
                    </TableCell>
                    <TableCell>{new Date(log.sent_at || log.created_at).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {logs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-ink/50">
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
