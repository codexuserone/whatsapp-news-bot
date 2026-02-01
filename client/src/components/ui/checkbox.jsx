import * as React from 'react';
import { cn } from '../../lib/utils';
import { Check } from 'lucide-react';

const Checkbox = React.forwardRef(({ className, checked, onChange, id, ...props }, ref) => {
  const inputRef = React.useRef(null);
  const combinedRef = (node) => {
    inputRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  const handleClick = () => {
    if (inputRef.current) {
      inputRef.current.click();
    }
  };

  return (
    <div className="relative inline-flex items-center">
      <input
        ref={combinedRef}
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
        {...props}
      />
      <div
        role="checkbox"
        aria-checked={checked}
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleClick();
          }
        }}
        className={cn(
          'h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'peer-checked:bg-primary peer-checked:text-primary-foreground',
          'cursor-pointer flex items-center justify-center',
          className
        )}
      >
        {checked && <Check className="h-3 w-3 text-white" />}
      </div>
    </div>
  );
});
Checkbox.displayName = 'Checkbox';

export { Checkbox };
