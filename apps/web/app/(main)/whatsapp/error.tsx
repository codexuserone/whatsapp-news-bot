'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type WhatsAppPageErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function WhatsAppPageError({ error, reset }: WhatsAppPageErrorProps) {
  useEffect(() => {
    console.error('WhatsApp page runtime error:', error);
  }, [error]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            WhatsApp page could not load
          </CardTitle>
          <CardDescription>
            A client error occurred while rendering this screen. Your data was not changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {String(error?.message || 'Unknown client error')}
          </div>
          <Button type="button" onClick={reset}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry loading WhatsApp page
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

