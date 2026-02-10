'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

const WhatsAppErrorPage = ({ error, reset }: ErrorProps) => {
  return (
    <div className="space-y-6">
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>WhatsApp page failed to load</CardTitle>
          <CardDescription>
            The page hit a client error. Try refresh. If it repeats, open Targets and reconnect WhatsApp.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground break-words">{error?.message || 'Unknown client error'}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={reset}>
              Try again
            </Button>
            <Button variant="outline" asChild>
              <Link href="/targets">Open Targets</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default WhatsAppErrorPage;
