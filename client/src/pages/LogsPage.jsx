import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Select } from '../components/ui/select';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';

const LogsPage = () => {
  const [status, setStatus] = useState('');
  const { data: logs = [] } = useQuery({
    queryKey: ['logs', status],
    queryFn: () => api.get(status ? `/api/logs?status=${status}` : '/api/logs'),
    refetchInterval: 10000
  });

  return (
    <div className="space-y-8">
      <PageHeader title="Logs" subtitle="Inspect sent, skipped, and failed delivery attempts." />
      <Card>
        <CardHeader>
          <CardTitle>Delivery Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 max-w-xs">
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="queued">Queued</option>
              <option value="sent">Sent</option>
              <option value="skipped">Skipped</option>
              <option value="failed">Failed</option>
            </Select>
          </div>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Target</TableHeaderCell>
                <TableHeaderCell>Feed Item</TableHeaderCell>
                <TableHeaderCell>Time</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {logs.map((log) => (
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
                    No logs found.
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

export default LogsPage;
