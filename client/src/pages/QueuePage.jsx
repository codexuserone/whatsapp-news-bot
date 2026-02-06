import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { ListOrdered, RefreshCw, Trash2, AlertTriangle, Loader2 } from 'lucide-react';

const QueuePage = () => {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('all');

  const { data: queueStats } = useQuery({
    queryKey: ['queue-stats'],
    queryFn: () => api.get('/api/queue/stats'),
    refetchInterval: 10000
  });

  const { data: queueItems = [], isLoading } = useQuery({
    queryKey: ['queue', statusFilter],
    queryFn: () => api.get(statusFilter === 'all' ? '/api/queue' : `/api/queue?status=${statusFilter}`),
    refetchInterval: 10000
  });

  const { data: shabbosStatus } = useQuery({
    queryKey: ['shabbos-status'],
    queryFn: () => api.get('/api/shabbos/status'),
    refetchInterval: 60000
  });

  const getScheduleName = (item) => item?.schedule_name || 'Unknown Schedule';
  const getTargetLabel = (item) => {
    const name = item?.target_name || 'Unknown Target';
    const type = item?.target_type ? ` (${item.target_type})` : '';
    return `${name}${type}`;
  };

  const deleteItem = useMutation({
    mutationFn: (id) => api.delete(`/api/queue/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] })
  });

  const clearPending = useMutation({
    mutationFn: () => api.delete('/api/queue/clear?status=pending'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] })
  });

  const retryFailed = useMutation({
    mutationFn: () => api.post('/api/queue/retry-failed'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] })
  });

  const resetProcessing = useMutation({
    mutationFn: () => api.post('/api/queue/reset-processing'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['queue-stats'] });
    }
  });

  const getStatusBadge = (status) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary">Pending</Badge>;
      case 'processing':
        return <Badge variant="outline">Processing</Badge>;
      case 'sent':
        return <Badge variant="success">Sent</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      case 'skipped':
        return <Badge variant="warning">Skipped</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Message Queue</h1>
          <p className="text-muted-foreground">View and manage queued messages.</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => resetProcessing.mutate()}
            disabled={resetProcessing.isPending || !(queueStats?.processing > 0)}
            title={queueStats?.processing > 0 ? 'Reset stuck processing items' : 'No processing items'}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${resetProcessing.isPending ? 'animate-spin' : ''}`} />
            Reset Processing
          </Button>
          <Button
            variant="outline"
            onClick={() => retryFailed.mutate()}
            disabled={retryFailed.isPending}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${retryFailed.isPending ? 'animate-spin' : ''}`} />
            Retry Failed
          </Button>
          <Button
            variant="destructive"
            onClick={() => clearPending.mutate()}
            disabled={clearPending.isPending}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Clear Pending
          </Button>
        </div>
      </div>

      {/* Shabbos Banner */}
      {shabbosStatus?.isShabbos && (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="rounded-full bg-warning/20 p-2">
              <AlertTriangle className="h-5 w-5 text-warning-foreground" />
            </div>
            <div className="flex-1">
              <p className="font-medium">Shabbos Mode Active</p>
              <p className="text-sm text-muted-foreground">
                Messages are being held. Will resume at {formatDate(shabbosStatus.endsAt)}
              </p>
            </div>
            <Badge variant="warning" className="text-sm px-3 py-1">
              {shabbosStatus.reason}
            </Badge>
          </CardContent>
        </Card>
      )}

      {/* Filter */}
      <div className="flex items-center gap-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Select status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="skipped">Skipped</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {queueItems.length} item{queueItems.length !== 1 ? 's' : ''}
        </span>
        {queueStats && (
          <span className="text-xs text-muted-foreground">
            {queueStats.pending} pending · {queueStats.processing} processing · {queueStats.failed} failed
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          Manual/test sends are hidden from queue by default.
        </span>
      </div>

      {/* Queue Items */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ListOrdered className="h-5 w-5" />
            Queue Items
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : queueItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No messages in queue with status "{statusFilter === 'all' ? 'any' : statusFilter}"
            </div>
          ) : (
            <div className="space-y-3">
              {queueItems.map((item) => (
                <div key={item.id} className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {getStatusBadge(item.status)}
                        <span className="text-xs text-muted-foreground">
                          {getScheduleName(item)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          to {getTargetLabel(item)}
                        </span>
                      </div>
                      <p className="font-medium truncate">{item.title || 'No title'}</p>
                      {item.url && (
                        <a 
                          href={item.url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline truncate block"
                        >
                          {item.url}
                        </a>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => deleteItem.mutate(item.id)}
                      disabled={deleteItem.isPending}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {item.rendered_content && (
                    <div className="rounded-md bg-muted p-3">
                      <p className="text-xs text-muted-foreground mb-1">Sent content:</p>
                      <p className="text-sm whitespace-pre-wrap line-clamp-3">
                        {item.rendered_content}
                      </p>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span>Created: {formatDate(item.created_at)}</span>
                    {item.scheduled_for && (
                      <span>Scheduled: {formatDate(item.scheduled_for)}</span>
                    )}
                    {item.sent_at && (
                      <span>Sent: {formatDate(item.sent_at)}</span>
                    )}
                    {item.error_message && (
                      <span className="text-destructive">Error: {item.error_message}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default QueuePage;
