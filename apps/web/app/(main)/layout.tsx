'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AppSidebar from '@/components/layout/AppSidebar';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import Breadcrumbs from '@/components/layout/Breadcrumbs';
import ThemeToggle from '@/components/layout/ThemeToggle';
import { navLookup } from '@/lib/navigation';
import { Home, Rss, ListOrdered, ClipboardList, MessageSquare } from 'lucide-react';

type MainLayoutProps = {
  children: React.ReactNode;
};

const titleCase = (value: string) => value.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

const getMobileTitle = (pathname: string) => {
  if (navLookup[pathname]) return navLookup[pathname]!;
  const parts = pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return last ? titleCase(last) : 'Overview';
};

const mobileNavItems = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/feeds', label: 'Feeds', icon: Rss },
  { to: '/queue', label: 'Queue', icon: ListOrdered },
  { to: '/feed-items', label: 'Items', icon: ClipboardList },
  { to: '/whatsapp', label: 'WA', icon: MessageSquare }
];

const isPathActive = (pathname: string, to: string) => {
  if (to === '/') return pathname === '/';
  return pathname.startsWith(to);
};

const MainLayout = ({ children }: MainLayoutProps) => {
  const pathname = usePathname();
  const mobileTitle = getMobileTitle(pathname);

  return (
    <SidebarProvider className="max-w-full overflow-x-clip">
      <AppSidebar />
      <SidebarInset className="min-w-0 bg-background/80">
        <header className="sticky top-0 z-30 flex h-16 min-w-0 max-w-full shrink-0 items-center gap-2 border-b bg-background/70 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <SidebarTrigger className="-ml-1 h-11 w-11 rounded-md border border-border bg-background/80" />
          <span className="md:hidden text-sm font-medium">{mobileTitle}</span>
          <Separator orientation="vertical" className="mr-2 h-4" />
          <div className="flex min-w-0 flex-1 items-center justify-between">
            <div className="hidden md:block">
              <Breadcrumbs />
            </div>
            <div className="flex items-center gap-3">
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="relative min-w-0 max-w-full flex-1 overflow-y-auto overflow-x-hidden px-4 pb-24 pt-6 md:px-8 md:pb-8">
          <div className="mx-auto min-w-0 w-full max-w-6xl">
            <div key={pathname} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
              {children}
            </div>
          </div>
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-40 max-w-full border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          <div className="mx-auto grid max-w-3xl grid-cols-5">
            {mobileNavItems.map((item) => {
              const Icon = item.icon;
              const active = isPathActive(pathname, item.to);
              return (
                <Link
                  key={item.to}
                  href={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={`flex min-h-14 flex-col items-center gap-1 px-2 py-3 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                    active ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default MainLayout;
