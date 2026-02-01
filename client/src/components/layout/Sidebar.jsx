import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { navSections } from '../../lib/navigation';
import { cn } from '../../lib/utils';

const Sidebar = () => {
  const location = useLocation();

  const renderItem = (item, depth = 0) => {
    const Icon = item.icon;
    const isRoot = depth === 0;
    const isHashLink = item.to?.includes('#');
    return (
      <div key={`${item.label}-${item.to || depth}`} className="space-y-1">
        <NavLink
          to={item.to}
          className={({ isActive }) => {
            const isHashActive = isHashLink && `${location.pathname}${location.hash}` === item.to;
            const linkActive = isHashActive || (!isHashLink && isActive);
            return cn(
              'flex items-center gap-3 rounded-2xl px-3 py-2 transition',
              isRoot ? 'text-sm font-medium' : 'text-xs font-semibold uppercase tracking-wide',
              linkActive ? (isRoot ? 'bg-ink text-white' : 'bg-highlight text-ink') : 'text-ink/70 hover:bg-ink/10'
            );
          }}
          end={item.to === '/'}
        >
          {Icon && isRoot && <Icon className="h-4 w-4" />}
          <span>{item.label}</span>
        </NavLink>
        {item.children && (
          <div
            className={cn(
              'space-y-1 border-l border-ink/10',
              isRoot ? 'ml-8 pl-3' : 'ml-5 pl-3'
            )}
          >
            {item.children.map((child) => renderItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="glass-panel sticky top-6 hidden h-[calc(100vh-3rem)] flex-col rounded-3xl border border-white/40 p-6 shadow-soft lg:flex">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-ink text-white">
          WA
        </div>
        <div>
          <p className="font-display text-lg">Anash News Bot</p>
          <p className="text-xs text-ink/60">WhatsApp automation suite</p>
        </div>
      </div>
      <div className="mt-8 flex-1 space-y-6 overflow-y-auto pr-2">
        {navSections.map((section) => (
          <div key={section.title} className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink/50">{section.title}</p>
            <div className="space-y-1">{section.items.map((item) => renderItem(item))}</div>
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-ink/10 bg-white/70 p-4 text-xs text-ink/60">
        QR auth runs securely in-app. Keep the uptime bot running on Render.
      </div>
    </aside>
  );
};

export default Sidebar;
