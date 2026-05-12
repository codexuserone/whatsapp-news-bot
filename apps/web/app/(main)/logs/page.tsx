'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { LogEntry } from '@/lib/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHeaderCell } from '@/components/ui/table';
import { Activity, AlertTriangle, Loader2 } from 'lucide-react';

const STATUS_COLORS: Record<string, 'success' | 'destructive' | 'warning' | 'secondary'> = {
  pending: 'warning',
  processing: 'secondary',
  awaiting_approval: 'warning',
  sent: 'success',
  delivered: 'success',
  read: 'success',
  played: 'success',
  skipped: 'warning',
  failed: 'destructive',
  superseded: 'secondary'
};

const LOG_FILTERS = [
  { value: 'all', label: 'All activity' },
  { value: 'awaiting_approval', label: 'Held' },
  { value: 'pending', label: 'Queued' },
  { value: 'processing', label: 'Sending' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'superseded', label: 'Superseded' }
];

const getStatusLabel = (status: string) => {
  switch (status) {
    case 'sent':
      return 'Sent';
    case 'failed':
      return 'Failed';
    case 'pending':
      return 'Queued';
    case 'processing':
      return 'Sending';
    case 'awaiting_approval':
      return 'Held';
    case 'delivered':
    case 'read':
    case 'played':
      return 'Sent';
    case 'skipped':
      return 'Skipped';
    case 'superseded':
      return 'Superseded';
    default:
      return status || 'Unknown';
  }
};

const getWhenDate = (log: LogEntry) =>
  log.sent_at ||
  log.delivered_at ||
  log.read_at ||
  log.played_at ||
  log.scheduled_for ||
  log.processing_started_at ||
  log.created_at;

const getSequenceStepLabel = (log: LogEntry) => {
  const explicit = String(log.sequence_step_label || '').trim();
  if (explicit) return explicit;
  const index = Number(log.sequence_step_index);
  if (Number.isFinite(index) && index > 0) return `Step ${index + 1}`;
  return '';
};

const getMediaSummary = (log: LogEntry) => {
  const mediaType = String(log.media_type || '').trim().toLowerCase();
  const hasMedia = Boolean(mediaType || String(log.media_url || '').trim());
  if (!hasMedia) return { label: 'Text only', variant: 'outline' as const };
  const label = mediaType || 'media';
  if (log.media_sent) return { label: `${label} sent`, variant: 'success' as const };
  if (log.media_error) return { label: `${label} failed`, variant: 'destructive' as const };
  if (log.status === 'pending' || log.status === 'processing' || log.status === 'awaiting_approval') {
    return { label: `${label} queued`, variant: 'secondary' as const };
  }
  return { label: `${label} requested`, variant: 'warning' as const };
};

const LogsPage = () => {
  const [status, setStatus] = useState('all');
  const { data: logs = [], isLoading, error } = useQuery<LogEntry[]>({
    queryKey: ['logs', status],
    queryFn: () => api.get(status === 'all' ? '/api/logs?include_queue=true' : `/api/logs?status=${status}`),
    refetchInterval: 30000
  });
  const logsErrorMessage = error instanceof Error ? error.message : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">History</h1>
        <p className="text-muted-foreground">Dispatch records for queued, sent, failed, and corrected messages.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Dispatch Records
              </CardTitle>
              <p className="text-sm text-muted-foreground">{logs.length} message{logs.length !== 1 ? 's' : ''}</p>
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                {LOG_FILTERS.map((filter) => (
                  <SelectItem key={filter.value} value={filter.value}>
                    {filter.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {logsErrorMessage ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">History is temporarily unavailable</div>
                  <div className="mt-1 text-xs text-amber-100/80">{logsErrorMessage}</div>
                </div>
              </div>
            </div>
          ) : isLoading ? (
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
                    <TableHeaderCell>Media</TableHeaderCell>
                    <TableHeaderCell className="hidden lg:table-cell">Content</TableHeaderCell>
                    <TableHeaderCell>When</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => {
                    const mediaSummary = getMediaSummary(log);
                    return (
                      <TableRow key={log.id}>
                        <TableCell>
                          <Badge
                            variant={STATUS_COLORS[log.status] || 'secondary'}
                            title={log.error_message || undefined}
                          >
                            {getStatusLabel(log.status)}
                          </Badge>
                          {getSequenceStepLabel(log) ? (
                            <Badge variant="outline" className="ml-1">
                              {getSequenceStepLabel(log)}
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="font-medium">
                          <div className="flex flex-wrap items-center gap-1">
                            <span>{log.target?.name || log.target_id}</span>
                            {log.target_active === false ? <Badge variant="warning">Inactive target</Badge> : null}
                            {log.target_in_current_schedule === false ? <Badge variant="outline">Old target</Badge> : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={mediaSummary.variant} title={log.media_error || undefined}>
                            {mediaSummary.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden max-w-xs text-muted-foreground lg:table-cell">
                          <div className="space-y-1">
                            <p className="truncate" title={log.message_content || undefined}>
                              {log.message_content?.substring(0, 80) || '-'}
                            </p>
                            {log.error_message ? (
                              <p className="truncate text-xs text-destructive" title={log.error_message}>
                                {log.error_message}
                              </p>
                            ) : null}
                            {log.media_error ? (
                              <p className="truncate text-xs text-destructive" title={log.media_error}>
                                Media: {log.media_error}
                              </p>
                            ) : null}
                            {log.correction_error ? (
                              <p className="truncate text-xs text-warning-foreground" title={log.correction_error}>
                                Correction: {log.correction_error}
                              </p>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(getWhenDate(log)).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {logs.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                        No records match this filter.
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
