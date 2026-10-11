import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.14em] uppercase",
  {
    variants: {
      tone: {
        neutral: "border-line-2 text-muted",
        acid: "border-acid text-acid",
        blood: "border-blood text-blood",
        sky: "border-sky text-sky",
        solid: "border-acid bg-acid text-ink",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  children,
}: VariantProps<typeof badgeVariants> & { className?: string; children: React.ReactNode }) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}
