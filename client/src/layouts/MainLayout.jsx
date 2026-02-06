import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
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
import ThemeToggle from '../components/layout/ThemeToggle';

const statusVariant = (status) => {
  if (status === 'connected') return 'success';
  if (status === 'qr' || status === 'qr_ready' || status === 'connecting') return 'warning';
  return 'destructive';
};

const MainLayout = () => {
  const location = useLocation();
  const { data: status } = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/api/whatsapp/status'),
    refetchInterval: 15000
  });

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="bg-background/80">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b bg-background/70 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <div className="flex flex-1 items-center justify-between">
            <Breadcrumbs />
            <div className="flex items-center gap-3">
              <div className="hidden text-right sm:block">
                <p className="text-xs text-muted-foreground">WhatsApp</p>
                <p className="text-xs font-medium">
                  {status?.status === 'connected'
                    ? 'Connected'
                    : status?.lastError
                      ? 'Error'
                      : 'Not connected'}
                </p>
              </div>
              <Badge variant={statusVariant(status?.status)} className="capitalize">
                {status?.status || 'unknown'}
              </Badge>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="relative flex-1 overflow-auto px-4 pb-8 pt-6 md:px-8">
          <div className="mx-auto w-full max-w-6xl">
            <div
              key={location.pathname}
              className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300"
            >
              <Outlet />
            </div>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default MainLayout;
