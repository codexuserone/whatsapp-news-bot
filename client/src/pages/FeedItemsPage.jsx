import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';
import { Badge } from '../components/ui/badge';

const FeedItemsPage = () => {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['feed-items'],
    queryFn: () => api.get('/api/feed-items'),
    refetchInterval: 15000
  });

  return (
    <div className="space-y-8">
      <PageHeader title="Feed Items" subtitle="Recently ingested feed entries available for dispatch." />
      <Card>
        <CardHeader>
          <CardTitle>Latest Items ({items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8 text-ink/50">Loading feed items...</div>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Title</TableHeaderCell>
                  <TableHeaderCell>Feed</TableHeaderCell>
                  <TableHeaderCell>Link</TableHeaderCell>
                  <TableHeaderCell>Published</TableHeaderCell>
                  <TableHeaderCell>Sent</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="max-w-xs truncate font-medium" title={item.title}>
                      {item.title || 'Untitled'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{item.feed?.name || 'Unknown'}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-ink/60">
                      {item.link ? (
                        <a href={item.link} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {item.link}
                        </a>
                      ) : '—'}
                    </TableCell>
                    <TableCell>
                      {item.pub_date ? new Date(item.pub_date).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={item.sent ? 'success' : 'secondary'}>
                        {item.sent ? 'Sent' : 'Pending'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-ink/50">
                      No feed items yet. Add feeds and refresh them to see items here.
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

export default FeedItemsPage;
