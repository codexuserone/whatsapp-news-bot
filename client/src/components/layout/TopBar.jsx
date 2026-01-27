import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '../ui/badge';
import Breadcrumbs from './Breadcrumbs';
import { api } from '../../lib/api';

const statusVariant = (status) => {
  if (status === 'connected') return 'success';
  if (status === 'qr' || status === 'connecting') return 'warning';
  return 'danger';
};

const TopBar = () => {
  const { data: status } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 5000
  });

  return (
    <header className="glass-panel flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-white/40 px-6 py-4 shadow-soft">
      <div>
        <Breadcrumbs />
        <p className="mt-2 text-xs text-ink/60">Automate, schedule, and audit WhatsApp delivery safely.</p>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right">
          <p className="text-xs font-semibold uppercase text-ink/50">WhatsApp status</p>
          <p className="text-sm text-ink/70">{status?.lastError || 'All systems steady'}</p>
        </div>
        <Badge variant={statusVariant(status?.status)}>{status?.status || 'unknown'}</Badge>
      </div>
    </header>
  );
};

export default TopBar;
