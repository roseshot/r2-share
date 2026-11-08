import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { Input as BaseInput } from "@base-ui/react/input";
import { Select as BaseSelect } from "@base-ui/react/select";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export const buttonStyles = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 data-disabled:pointer-events-none data-disabled:opacity-45 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-emerald-400 text-zinc-950 hover:bg-emerald-300",
        secondary: "border border-zinc-200 dark:border-white/12 bg-zinc-900/5 dark:bg-white/8 text-zinc-900 dark:text-zinc-100 hover:bg-zinc-900/10 dark:hover:bg-white/13",
        ghost: "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-900/5 dark:hover:bg-white/8 hover:text-zinc-900 dark:hover:text-white",
        destructive: "border border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20",
      },
      size: { default: "h-10", sm: "h-8 px-3", icon: "size-9 p-0" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = Omit<ComponentProps<typeof BaseButton>, "className"> &
  VariantProps<typeof buttonStyles> & { className?: string };

export function Button({ variant, size, className, type = "button", ...props }: ButtonProps) {
  return (
    <BaseButton
      type={type}
      className={cn(buttonStyles({ variant, size }), className)}
      {...props}
    />
  );
}

type InputProps = Omit<ComponentProps<typeof BaseInput>, "className"> & { className?: string };

export function Input({ className, ...props }: InputProps) {
  return (
    <BaseInput
      className={cn(
        "h-11 w-full rounded-xl border border-zinc-200 dark:border-white/12 bg-white dark:bg-zinc-900 px-3.5 text-sm text-zinc-900 dark:text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/50",
        className,
      )}
      {...props}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
}

export function Select({ id, value, onValueChange, options, disabled, className }: SelectProps) {
  return (
    <BaseSelect.Root
      items={options}
      value={value}
      onValueChange={next => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        id={id}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-zinc-200 dark:border-white/12 bg-white dark:bg-zinc-900 px-3.5 text-left text-sm text-zinc-900 dark:text-zinc-100 outline-none focus-visible:border-emerald-400 focus-visible:ring-1 focus-visible:ring-emerald-400/50 data-disabled:cursor-not-allowed data-disabled:opacity-50",
          className,
        )}
      >
        <BaseSelect.Value className="truncate" />
        <BaseSelect.Icon className="shrink-0 text-zinc-600 dark:text-zinc-400" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={6} align="start" className="z-50">
          <BaseSelect.Popup className="max-h-64 min-w-(--anchor-width) overflow-y-auto rounded-xl border border-zinc-200 dark:border-white/15 bg-white dark:bg-zinc-900 p-1.5 text-zinc-900 dark:text-zinc-100 shadow-2xl outline-none">
            <BaseSelect.List>
              {options.map(option => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  className="flex cursor-default items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm outline-none data-highlighted:bg-zinc-900/10 dark:data-highlighted:bg-white/10 data-selected:text-emerald-700 dark:data-selected:text-emerald-300"
                >
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="text-emerald-700 dark:text-emerald-300">✓</BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-zinc-200 dark:border-white/10 bg-white/90 dark:bg-zinc-900/75 shadow-[0_12px_70px_-30px_rgba(0,0,0,.7)]",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({ children, variant = "default" }: { children: ReactNode; variant?: "default" | "muted" }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
      variant === "default"
        ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300"
        : "border-zinc-200 dark:border-white/10 bg-zinc-900/5 dark:bg-white/5 text-zinc-600 dark:text-zinc-400",
    )}>
      {children}
    </span>
  );
}
