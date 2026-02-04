import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { navLookup } from '../../lib/navigation';
import { cn } from '../../lib/utils';

const titleCase = (value) => value.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

const Breadcrumbs = () => {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);
  const crumbs = [{ label: navLookup['/'] || 'Overview', to: '/' }];

  segments.forEach((segment, index) => {
    const to = `/${segments.slice(0, index + 1).join('/')}`;
    const label = navLookup[to] || titleCase(segment);
    crumbs.push({ label, to });
  });

  return (
    <nav className="flex items-center gap-1 text-sm">
      {crumbs.map((crumb, index) => (
        <React.Fragment key={`${crumb.to}-${index}`}>
          {index > 0 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <Link
            to={crumb.to}
            className={cn(
              'rounded-md px-2 py-1 transition-colors hover:bg-accent',
              index === crumbs.length - 1 
                ? 'font-medium text-foreground' 
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {crumb.label}
          </Link>
        </React.Fragment>
      ))}
    </nav>
  );
};

export default Breadcrumbs;
