import { useState } from "react";

import { cn } from "~/lib/utils";

export function Code({ children, className }: { children: string; className?: string }) {
  return (
    <code
      className={cn("border-line bg-ink text-acid border px-1.5 py-0.5 text-[12px]", className)}
    >
      {children}
    </code>
  );
}

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="hairline bg-ink flex items-stretch">
      {label ? (
        <span className="eyebrow border-line flex items-center border-r px-3">{label}</span>
      ) : null}
      <pre className="text-paper flex-1 overflow-x-auto px-3 py-2 text-[12px]">{text}</pre>
      <button
        className="border-line text-muted hover:text-acid border-l px-3 font-mono text-[10px] tracking-[0.14em] uppercase"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        type="button"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
