import React from 'react';
import { Link, useLocation } from 'react-router-dom';
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

  if (location.hash) {
    const hashKey = `${location.pathname}${location.hash}`;
    const hashLabel = navLookup[hashKey] || titleCase(location.hash.slice(1));
    crumbs.push({ label: hashLabel, to: hashKey });
  }

  return (
    <nav className="flex flex-wrap items-center gap-2 text-sm text-ink/60">
      {crumbs.map((crumb, index) => (
        <React.Fragment key={`${crumb.to}-${index}`}>
          <Link
            to={crumb.to}
            className={cn('rounded-full px-2 py-1 transition hover:bg-ink/10', index === crumbs.length - 1 && 'text-ink')}
          >
            {crumb.label}
          </Link>
          {index < crumbs.length - 1 && <span className="text-ink/30">/</span>}
        </React.Fragment>
      ))}
    </nav>
  );
};

export default Breadcrumbs;
