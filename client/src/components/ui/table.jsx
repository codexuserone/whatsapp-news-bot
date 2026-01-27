import React from 'react';
import { cn } from '../../lib/utils';

const Table = React.forwardRef(({ className, ...props }, ref) => (
  <table ref={ref} className={cn('w-full text-sm', className)} {...props} />
));
Table.displayName = 'Table';

const TableHead = React.forwardRef(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn('text-left text-xs uppercase tracking-wide text-ink/60', className)} {...props} />
));
TableHead.displayName = 'TableHead';

const TableBody = React.forwardRef(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('divide-y divide-ink/10', className)} {...props} />
));
TableBody.displayName = 'TableBody';

const TableRow = React.forwardRef(({ className, ...props }, ref) => (
  <tr ref={ref} className={cn('hover:bg-ink/5', className)} {...props} />
));
TableRow.displayName = 'TableRow';

const TableCell = React.forwardRef(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-4 py-3 text-sm text-ink', className)} {...props} />
));
TableCell.displayName = 'TableCell';

const TableHeaderCell = React.forwardRef(({ className, ...props }, ref) => (
  <th ref={ref} className={cn('px-4 py-3 text-xs font-semibold text-ink/70', className)} {...props} />
));
TableHeaderCell.displayName = 'TableHeaderCell';

export { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell };
