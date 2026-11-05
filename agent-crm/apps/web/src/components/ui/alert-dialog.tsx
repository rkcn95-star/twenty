'use client';

import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <AlertDialogPrimitive.Content
        className={cn(
          'fixed top-[50%] left-[50%] z-50 grid w-full max-w-[380px] translate-x-[-50%] translate-y-[-50%] gap-3 rounded-lg border bg-background p-4 shadow-lg',
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

const AlertDialogTitle = ({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) => (
  <AlertDialogPrimitive.Title className={cn('text-[14px] font-semibold', className)} {...props} />
);
const AlertDialogDescription = ({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Description>) => (
  <AlertDialogPrimitive.Description className={cn('text-muted-foreground', className)} {...props} />
);
const AlertDialogFooter = ({ className, ...props }: React.ComponentProps<'div'>) => <div className={cn('flex justify-end gap-2', className)} {...props} />;
const AlertDialogCancel = ({ children = 'Cancel', ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) => (
  <AlertDialogPrimitive.Cancel asChild {...props}><Button variant="outline">{children}</Button></AlertDialogPrimitive.Cancel>
);
const AlertDialogAction = ({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Action>) => (
  <AlertDialogPrimitive.Action className={cn('inline-flex h-7 items-center justify-center rounded-[4px] bg-destructive px-2.5 text-[13px] font-medium text-white hover:bg-destructive/90', className)} {...props} />
);

export { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger };
