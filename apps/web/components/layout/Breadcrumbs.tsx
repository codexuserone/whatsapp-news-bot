'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { navLookup } from '@/lib/navigation';
import { cn } from '@/lib/utils';

const titleCase = (value: string) => value.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

const Breadcrumbs = () => {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);
  const crumbs = [{ label: navLookup['/'] || 'Overview', to: '/' }];

  segments.forEach((segment, index) => {
    const to = `/${segments.slice(0, index + 1).join('/')}`;
    const label = navLookup[to] || titleCase(segment);
    crumbs.push({ label, to });
  });

  return (
    <nav className="flex items-center gap-1 text-sm">
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.to}-${index}`} className="flex items-center gap-1">
          {index > 0 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <Link
            href={crumb.to}
            className={cn(
              'rounded-md px-2 py-1 transition-colors hover:bg-accent',
              index === crumbs.length - 1
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {crumb.label}
          </Link>
        </span>
      ))}
    </nav>
  );
};

export default Breadcrumbs;
