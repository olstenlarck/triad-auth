import { diffLines } from "diff";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import type { ChangeView } from "~/lib/types";

interface Line {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

const CONTEXT = 3;

function linesOf(change: ChangeView): Line[] {
  const parts = diffLines(change.oldText ?? "", change.newText ?? "");
  const lines: Line[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const part of parts) {
    const rows = part.value.replace(/\n$/, "").split("\n");
    for (const text of rows) {
      if (part.added) {
        lines.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
      } else if (part.removed) {
        lines.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
      } else {
        lines.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
      }
    }
  }

  return lines;
}

// Collapses runs of unchanged lines longer than twice the context into one expandable row.
function groups(lines: Line[]): Array<Line | { collapsed: Line[] }> {
  const out: Array<Line | { collapsed: Line[] }> = [];
  let run: Line[] = [];
  const flush = (atEnd: boolean) => {
    if (run.length <= CONTEXT * 2 + 1) {
      out.push(...run);
    } else {
      const head = out.length === 0 ? [] : run.slice(0, CONTEXT);
      const tail = atEnd ? [] : run.slice(run.length - CONTEXT);
      const middle = run.slice(head.length, run.length - tail.length);
      out.push(...head, { collapsed: middle }, ...tail);
    }
    run = [];
  };
  for (const line of lines) {
    if (line.kind === "ctx") {
      run.push(line);
    } else {
      flush(false);
      out.push(line);
    }
  }
  flush(true);

  return out;
}

export function FileDiff({ change }: { change: ChangeView }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const tone =
    change.status === "added" ? "acid" : change.status === "removed" ? "blood" : "neutral";
  const rows = change.binary ? [] : groups(linesOf(change));
  const added = rows.filter((row) => "kind" in row && row.kind === "add").length;
  const removed = rows.filter((row) => "kind" in row && row.kind === "del").length;

  return (
    <section className="hairline bg-ink-2" id={`diff-${change.path}`}>
      <header className="border-line flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <button
          className="flex items-center gap-3 text-left"
          onClick={() => setOpen(!open)}
          type="button"
        >
          <span className="text-muted font-mono text-[10px]">{open ? "▾" : "▸"}</span>
          <span className="text-paper">{change.path}</span>
          <Badge tone={tone}>{change.status}</Badge>
        </button>
        <span className="eyebrow">
          <span className="text-acid">+{added}</span> <span className="text-blood">-{removed}</span>
        </span>
      </header>
      {open ? (
        change.binary ? (
          <p className="text-muted px-4 py-3">Binary file.</p>
        ) : (
          <table className="w-full border-collapse font-mono text-[12px]">
            <tbody>
              {rows.map((row, index) =>
                "collapsed" in row ? (
                  expanded.has(index) ? (
                    row.collapsed.map((line) => (
                      <DiffRow key={`${index}-${line.oldNo}-${line.newNo}`} line={line} />
                    ))
                  ) : (
                    <tr key={`c-${index}`}>
                      <td className="bg-ink text-muted px-3 py-1 text-center" colSpan={3}>
                        <button
                          className="hover:text-acid"
                          onClick={() => setExpanded(new Set([...expanded, index]))}
                          type="button"
                        >
                          ··· {row.collapsed.length} unchanged lines ···
                        </button>
                      </td>
                    </tr>
                  )
                ) : (
                  <DiffRow key={`${row.kind}-${row.oldNo}-${row.newNo}`} line={row} />
                ),
              )}
            </tbody>
          </table>
        )
      ) : null}
    </section>
  );
}

function DiffRow({ line }: { line: Line }) {
  const className = line.kind === "add" ? "diff-add" : line.kind === "del" ? "diff-del" : "";
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";

  return (
    <tr className={className}>
      <td className="border-line text-muted w-12 border-r px-2 text-right select-none">
        {line.oldNo ?? ""}
      </td>
      <td className="border-line text-muted w-12 border-r px-2 text-right select-none">
        {line.newNo ?? ""}
      </td>
      <td className="px-3 break-all whitespace-pre-wrap">
        <span className="text-muted select-none">{marker} </span>
        {line.text}
      </td>
    </tr>
  );
}
