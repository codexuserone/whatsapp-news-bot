import * as React from 'react';
import { cn } from '../../lib/utils';
import { Check } from 'lucide-react';

const Checkbox = React.forwardRef(({ className, checked, onChange, ...props }, ref) => (
  <div className="relative inline-flex items-center">
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="peer sr-only"
      {...props}
    />
    <div
      className={cn(
        'h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'peer-checked:bg-primary peer-checked:text-primary-foreground',
        'cursor-pointer flex items-center justify-center',
        className
      )}
      onClick={() => {
        const input = ref?.current || document.activeElement;
        if (input && input.click) input.click();
      }}
    >
      {checked && <Check className="h-3 w-3 text-white" />}
    </div>
  </div>
));
Checkbox.displayName = 'Checkbox';

export { Checkbox };
