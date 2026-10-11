import { cn } from "~/lib/utils";

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <section className={cn("hairline bg-ink-2", className)}>{children}</section>;
}

export function CardHeader({
  title,
  action,
  eyebrow,
}: {
  title: string;
  eyebrow?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="border-line flex items-end justify-between gap-4 border-b px-4 py-3">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h3 className="text-sm">{title}</h3>
      </div>
      {action}
    </header>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("px-4 py-4", className)}>{children}</div>;
}
