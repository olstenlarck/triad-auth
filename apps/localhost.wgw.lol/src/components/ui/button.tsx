import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 border font-mono text-xs font-bold tracking-[0.12em] whitespace-nowrap uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border-acid bg-acid text-ink hover:bg-acid-2 hover:border-acid-2",
        outline: "border-line-2 text-paper hover:border-paper bg-transparent",
        ghost: "text-muted hover:text-paper border-transparent",
        danger: "border-blood text-blood hover:bg-blood hover:text-ink bg-transparent",
      },
      size: {
        sm: "h-8 px-3",
        md: "h-10 px-4",
        lg: "h-12 px-6 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button className={cn(buttonVariants({ variant, size }), className)} type={type} {...props} />
  );
}
