import React from 'react';
import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import AppSidebar from '../components/layout/AppSidebar';
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger
} from '../components/ui/sidebar';
import { Separator } from '../components/ui/separator';
import { Badge } from '../components/ui/badge';
import Breadcrumbs from '../components/layout/Breadcrumbs';

const statusVariant = (status) => {
  if (status === 'connected') return 'success';
  if (status === 'qr' || status === 'connecting') return 'warning';
  return 'destructive';
};

const MainLayout = () => {
  const { data: status } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 5000
  });

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <div className="flex flex-1 items-center justify-between">
            <Breadcrumbs />
            <div className="flex items-center gap-3">
              <div className="hidden text-right sm:block">
                <p className="text-xs text-muted-foreground">WhatsApp</p>
                <p className="text-xs font-medium">{status?.lastError ? 'Error' : 'Ready'}</p>
              </div>
              <Badge variant={statusVariant(status?.status)}>
                {status?.status || 'unknown'}
              </Badge>
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default MainLayout;
