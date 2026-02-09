'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navSections } from '@/lib/navigation';
import { X } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar';

const isRouteActive = (pathname: string, to: string) => {
  if (to === '/') return pathname === '/';
  return pathname.startsWith(to);
};

const AppSidebar = () => {
  const pathname = usePathname();
  const { isMobile, setOpen } = useSidebar();
  const closeIfMobile = () => {
    if (isMobile) {
      setOpen(false);
    }
  };

  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center justify-between gap-3 px-2 py-2">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20 font-semibold text-sm">
              WA
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">WhatsApp News Bot</span>
              <span className="text-xs text-muted-foreground">Automation Suite</span>
            </div>
          </div>
          {isMobile ? (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </SidebarHeader>

      <SidebarContent className="scrollbar-hide">
        {navSections.map((section) => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  if (item.children?.length) {
                    return (
                      <SidebarMenuItem key={item.label}>
                        <Link href={item.to} onClick={closeIfMobile}>
                          <SidebarMenuButton isActive={isRouteActive(pathname, item.to)} className="w-full">
                            {Icon && <Icon className="h-4 w-4" />}
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        </Link>
                        <ul className="ml-4 mt-1 space-y-0.5">
                          {item.children.map((child) => (
                            <li key={child.to}>
                              <Link href={child.to} onClick={closeIfMobile}>
                                <SidebarMenuButton
                                  isActive={pathname === child.to}
                                  size="sm"
                                  className="w-full text-muted-foreground hover:text-foreground"
                                >
                                  <span>{child.label}</span>
                                </SidebarMenuButton>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </SidebarMenuItem>
                    );
                  }
                  return (
                    <SidebarMenuItem key={item.label}>
                      <Link href={item.to} onClick={closeIfMobile}>
                        <SidebarMenuButton isActive={isRouteActive(pathname, item.to)} className="w-full">
                          {Icon && <Icon className="h-4 w-4" />}
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </Link>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border" />
    </Sidebar>
  );
};

export default AppSidebar;
