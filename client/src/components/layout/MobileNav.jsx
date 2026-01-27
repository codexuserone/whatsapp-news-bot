import React from 'react';
import { NavLink } from 'react-router-dom';
import { navSections } from '../../lib/navigation';
import { cn } from '../../lib/utils';

const flatItems = navSections.flatMap((section) => section.items).slice(0, 5);

const MobileNav = () => (
  <nav className="glass-panel fixed bottom-4 left-4 right-4 z-40 rounded-3xl border border-white/50 px-4 py-3 shadow-soft lg:hidden">
    <div className="flex items-center justify-between">
      {flatItems.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.label}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-1 rounded-2xl px-3 py-2 text-[10px] font-semibold uppercase tracking-wide',
                isActive ? 'bg-ink text-white' : 'text-ink/60 hover:text-ink'
              )
            }
            end={item.to === '/'}
          >
            {Icon && <Icon className="h-4 w-4" />}
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </div>
  </nav>
);

export default MobileNav;
