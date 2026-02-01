import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Select } from '../components/ui/select';

const QueuePage = () => {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('pending');

  // Fetch queue items
  const { data: queueItems = [], isLoading } = useQuery({
    queryKey: ['queue', statusFilter],
    queryFn: () => api.get(`/api/queue?status=${statusFilter}`),
    refetchInterval: 10000
  });

  // Fetch Shabbos status
  const { data: shabbosStatus } = useQuery({
    queryKey: ['shabbos-status'],
    queryFn: () => api.get('/api/shabbos/status'),
    refetchInterval: 60000
  });

  // Fetch schedules for display names
  const { data: schedules = [] } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => api.get('/api/schedules')
  });

  const getScheduleName = (id) => {
    const schedule = schedules.find(s => s.id === id);
    return schedule?.name || 'Unknown Schedule';
  };

  // Delete queue item
  const deleteItem = useMutation({
    mutationFn: (id) => api.delete(`/api/queue/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] })
  });

  // Clear all pending items
  const clearPending = useMutation({
    mutationFn: () => api.delete('/api/queue/clear?status=pending'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] })
  });

  // Retry failed items
  const retryFailed = useMutation({
    mutationFn: () => api.post('/api/queue/retry-failed'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue'] })
  });

  const getStatusBadge = (status) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary">Pending</Badge>;
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
      <PageHeader 
        title="Message Queue" 
        subtitle="View and manage queued messages. Messages are held during Shabbos and sent automatically when it ends."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => retryFailed.mutate()}
              disabled={retryFailed.isPending}
            >
              Retry Failed
            </Button>
            <Button
              variant="destructive"
              onClick={() => clearPending.mutate()}
              disabled={clearPending.isPending}
            >
              Clear Pending
            </Button>
          </div>
        }
      />

      {/* Shabbos Status Banner */}
      {shabbosStatus?.isShabbos && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-amber-800">Shabbos Mode Active</p>
                <p className="text-sm text-amber-700">
                  Messages are being held. Will resume at {formatDate(shabbosStatus.endsAt)}
                </p>
              </div>
              <Badge variant="warning" className="text-lg px-4 py-2">
                {shabbosStatus.reason}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filter and Stats */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="pending">Pending</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
            <option value="">All</option>
          </Select>
          <span className="text-sm text-muted-foreground">
            {queueItems.length} item{queueItems.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Queue Items */}
      <Card>
        <CardHeader>
          <CardTitle>Queue Items</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground"></div>
            </div>
          ) : queueItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No messages in queue with status "{statusFilter || 'any'}"
            </div>
          ) : (
            <div className="space-y-3">
              {queueItems.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-border bg-card p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {getStatusBadge(item.status)}
                        <span className="text-xs text-muted-foreground">
                          {getScheduleName(item.schedule_id)}
                        </span>
                      </div>
                      <p className="font-medium truncate">{item.title || 'No title'}</p>
                      {item.url && (
                        <a 
                          href={item.url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 hover:underline truncate block"
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
                    >
                      Delete
                    </Button>
                  </div>

                  {/* Message Preview */}
                  {item.rendered_content && (
                    <div className="rounded-md bg-muted/50 p-3">
                      <p className="text-xs text-muted-foreground mb-1">Message Preview:</p>
                      <p className="text-sm whitespace-pre-wrap line-clamp-3">
                        {item.rendered_content}
                      </p>
                    </div>
                  )}

                  {/* Metadata */}
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span>Created: {formatDate(item.created_at)}</span>
                    {item.scheduled_for && (
                      <span>Scheduled: {formatDate(item.scheduled_for)}</span>
                    )}
                    {item.sent_at && (
                      <span>Sent: {formatDate(item.sent_at)}</span>
                    )}
                    {item.error_message && (
                      <span className="text-red-600">Error: {item.error_message}</span>
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
