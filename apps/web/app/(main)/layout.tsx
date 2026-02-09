'use client';

import { usePathname } from 'next/navigation';
import AppSidebar from '@/components/layout/AppSidebar';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import Breadcrumbs from '@/components/layout/Breadcrumbs';
import ThemeToggle from '@/components/layout/ThemeToggle';
import { navLookup } from '@/lib/navigation';

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

const MainLayout = ({ children }: MainLayoutProps) => {
  const pathname = usePathname();
  const mobileTitle = getMobileTitle(pathname);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="bg-background/80">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b bg-background/70 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <SidebarTrigger className="-ml-1 h-11 w-11 rounded-md border border-border bg-background/80" />
          <span className="md:hidden text-sm font-medium">{mobileTitle}</span>
          <Separator orientation="vertical" className="mr-2 h-4" />
          <div className="flex flex-1 items-center justify-between">
            <div className="hidden md:block">
              <Breadcrumbs />
            </div>
            <div className="flex items-center gap-3">
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="relative flex-1 overflow-auto px-4 pb-8 pt-6 md:px-8">
          <div className="mx-auto w-full max-w-6xl">
            <div key={pathname} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
              {children}
            </div>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default MainLayout;
