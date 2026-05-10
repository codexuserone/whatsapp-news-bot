'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { WhatsAppStatus } from '@/lib/types';
import { getDatabaseUnavailableMessage, useRuntimeStatus } from '@/lib/runtimeStatus';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, PauseCircle, QrCode } from 'lucide-react';

type SettingsLike = Record<string, unknown>;

const formatPausedAt = (value: unknown) => {
  const iso = String(value || '').trim();
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(new Date(parsed));
  } catch {
    return new Date(parsed).toLocaleString();
  }
};

const GlobalStatusBanner = () => {
  const { ready, databaseUnavailable } = useRuntimeStatus();

  const { data: whatsapp } = useQuery<WhatsAppStatus>({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 15000
  });

  const { data: settings } = useQuery<SettingsLike>({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
    refetchInterval: 60000
  });

  const appPaused = settings?.app_paused === true;
  const whatsappStatus = String(whatsapp?.status || 'unknown');
  const pausedAtLabel = formatPausedAt(settings?.whatsapp_paused_at);

  const banner = (() => {
    if (databaseUnavailable) {
      return {
        tone: 'destructive' as const,
        icon: AlertTriangle,
        title: 'Database temporarily unavailable',
        body: getDatabaseUnavailableMessage(ready),
        href: '/queue',
        hrefLabel: 'Open Queue'
      };
    }

    if (appPaused) {
      return {
        tone: 'destructive' as const,
        icon: AlertTriangle,
        title: 'App paused',
        body: 'All automations are paused (polling and sending).',
        href: '/settings',
        hrefLabel: 'Open Settings'
      };
    }

    if (whatsappStatus === 'paused') {
      const when = pausedAtLabel ? ` (since ${pausedAtLabel})` : '';
      return {
        tone: 'warning' as const,
        icon: PauseCircle,
        title: `WhatsApp paused${when}`,
        body: 'Sending is stopped until you resume the WhatsApp session.',
        href: '/whatsapp',
        hrefLabel: 'Open WhatsApp'
      };
    }

    if (whatsappStatus === 'qr' || whatsappStatus === 'qr_ready') {
      return {
        tone: 'warning' as const,
        icon: QrCode,
        title: 'WhatsApp needs a QR scan',
        body: 'Scan the QR code to reconnect.',
        href: '/whatsapp',
        hrefLabel: 'Open WhatsApp'
      };
    }

    if (whatsappStatus && whatsappStatus !== 'connected' && whatsappStatus !== 'connecting') {
      const raw = String(whatsapp?.lastError || '').trim();
      const suffix = raw ? ` ${raw}` : '';
      return {
        tone: 'destructive' as const,
        icon: AlertTriangle,
        title: `WhatsApp ${whatsappStatus}`,
        body: `Sending may be blocked.${suffix}`,
        href: '/whatsapp',
        hrefLabel: 'Open WhatsApp'
      };
    }

    return null;
  })();

  if (!banner) return null;

  const Icon = banner.icon;
  const toneClasses =
    banner.tone === 'destructive'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-warning/30 bg-warning/10 text-warning-foreground';

  return (
    <div
      role="status"
      className={`mb-5 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${toneClasses}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{banner.title}</span>
            <Badge variant="secondary" className="h-5 px-2 text-[11px]">
              Attention
            </Badge>
          </div>
          <p className="mt-0.5 text-xs opacity-90">{banner.body}</p>
        </div>
      </div>
      <Link
        href={banner.href}
        className="shrink-0 whitespace-nowrap text-xs font-medium underline underline-offset-4 opacity-90 hover:opacity-100"
      >
        {banner.hrefLabel}
      </Link>
    </div>
  );
};

export default GlobalStatusBanner;
