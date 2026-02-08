'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navSections } from '@/lib/navigation';
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
  SidebarMenuItem
} from '@/components/ui/sidebar';
import { HelpCircle } from 'lucide-react';

const isRouteActive = (pathname: string, to: string) => {
  if (to === '/') return pathname === '/';
  return pathname.startsWith(to);
};

const AppSidebar = () => {
  const pathname = usePathname();

  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20 font-semibold text-sm">
            WA
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">WhatsApp News Bot</span>
            <span className="text-xs text-muted-foreground">Automation Suite</span>
          </div>
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
                        <Link href={item.to}>
                          <SidebarMenuButton isActive={isRouteActive(pathname, item.to)} className="w-full">
                            {Icon && <Icon className="h-4 w-4" />}
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        </Link>
                        <ul className="ml-4 mt-1 space-y-0.5">
                          {item.children.map((child) => (
                            <li key={child.to}>
                              <Link href={child.to}>
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
                      <Link href={item.to}>
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

      <SidebarFooter className="border-t border-sidebar-border">
        <div className="p-2">
          <div className="rounded-lg bg-sidebar-accent/60 p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <HelpCircle className="h-4 w-4" />
              <span>Tip: edit or send out of order from Queue</span>
            </div>
          </div>
        </div>
      </SidebarFooter>

    </Sidebar>
  );
};

export default AppSidebar;
