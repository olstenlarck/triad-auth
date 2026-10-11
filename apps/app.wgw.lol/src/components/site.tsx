import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto max-w-6xl px-6 py-10", className)}>{children}</div>;
}

export function Kicker({ children }: { children: ReactNode }) {
  return <p className="text-signal font-mono text-xs tracking-[0.2em] uppercase">{children}</p>;
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-card flex min-w-0 items-stretch border font-mono text-xs">
      {label === undefined ? null : (
        <span className="text-muted-foreground border-r px-2 py-2">{label}</span>
      )}
      <code className="min-w-0 flex-1 truncate px-3 py-2">{value}</code>
      <button
        type="button"
        aria-label="Copy"
        className="text-muted-foreground hover:bg-accent hover:text-foreground border-l px-3"
        onClick={fire(async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })}
      >
        {copied ? <Check className="text-signal size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

export function Terminal({ children, title }: { children: string; title?: string }) {
  return (
    <div className="bg-card border">
      {title === undefined ? null : (
        <div className="text-muted-foreground border-b px-3 py-1.5 font-mono text-[11px] tracking-wider uppercase">
          {title}
        </div>
      )}
      <pre className="text-foreground/90 overflow-x-auto p-4 font-mono text-[12.5px] leading-6">
        {children}
      </pre>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (error === null) {
    return null;
  }
  return (
    <p className="border-destructive/60 bg-destructive/10 text-destructive border px-3 py-2 font-mono text-xs">
      {error}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground border border-dashed px-6 py-12 text-center font-mono text-sm">
      {children}
    </div>
  );
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs an async handler from a React event and reports its failure instead of returning a promise. */
export function fire<A extends unknown[]>(
  handler: (...args: A) => Promise<unknown>,
): (...args: A) => void {
  return (...args) => {
    handler(...args).catch((error: unknown) => console.error(error));
  };
}
