import React from 'react';
import { NavLink } from 'react-router-dom';
import { navSections } from '../../lib/navigation';
import { cn } from '../../lib/utils';
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
} from '../ui/sidebar';
import { MessageSquare, HelpCircle } from 'lucide-react';

const AppSidebar = () => {
  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
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
                  return (
                    <SidebarMenuItem key={item.label}>
                      <NavLink to={item.to} end={item.to === '/'}>
                        {({ isActive }) => (
                          <SidebarMenuButton isActive={isActive} className="w-full">
                            {Icon && <Icon className="h-4 w-4" />}
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        )}
                      </NavLink>
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
          <div className="rounded-lg bg-muted p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <HelpCircle className="h-4 w-4" />
              <span>Need help? Check the docs</span>
            </div>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
};

export default AppSidebar;
