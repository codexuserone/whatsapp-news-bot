import React from 'react';
import { cn } from '../../lib/utils';

const Badge = React.forwardRef(({ className, variant = 'default', ...props }, ref) => {
  const variants = {
    default: 'bg-ink text-white',
    outline: 'border border-ink/20 text-ink',
    secondary: 'bg-ink/10 text-ink/70',
    success: 'bg-emerald-500 text-white',
    warning: 'bg-amber-400 text-ink',
    danger: 'bg-red-500 text-white'
  };

  return (
    <span
      ref={ref}
      className={cn('inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold', variants[variant], className)}
      {...props}
    />
  );
});
Badge.displayName = 'Badge';

export { Badge };
