'use client';

import React from 'react';
import { Button } from '@/components/ui/button';

export default function WhatsAppPageError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const message = String(error?.message || 'Unexpected error').trim();
  return (
    <div className="mx-auto max-w-2xl space-y-4 rounded-lg border p-6">
      <h2 className="text-xl font-semibold">WhatsApp page could not load</h2>
      <p className="text-sm text-muted-foreground">
        {message || 'Unexpected error'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
