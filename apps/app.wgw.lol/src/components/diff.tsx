import type { FileDiff } from "~/lib/api";
import { cn } from "~/lib/utils";

function lineClass(line: string): string {
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff --git") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file")
  ) {
    return "text-muted-foreground";
  }
  if (line.startsWith("@@")) {
    return "bg-violet/10 text-violet";
  }
  if (line.startsWith("+")) {
    return "bg-signal/10 text-signal";
  }
  if (line.startsWith("-")) {
    return "bg-destructive/10 text-destructive";
  }
  return "";
}

export function DiffView({ files }: { files: FileDiff[] }) {
  if (files.length === 0) {
    return <p className="text-muted-foreground font-mono text-sm">No file changes.</p>;
  }
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground font-mono text-xs">
        {files.length} files · <span className="text-signal">+{additions}</span>{" "}
        <span className="text-destructive">−{deletions}</span>
      </p>
      {files.map((file) => (
        <div key={file.path} className="border">
          <div className="bg-card flex items-center gap-3 border-b px-3 py-2 font-mono text-xs">
            <span
              className={cn(
                "uppercase",
                file.status === "added"
                  ? "text-signal"
                  : file.status === "deleted"
                    ? "text-destructive"
                    : "text-violet",
              )}
            >
              {file.status}
            </span>
            <span className="font-semibold">{file.path}</span>
            <span className="text-signal ml-auto">+{file.additions}</span>
            <span className="text-destructive">−{file.deletions}</span>
          </div>
          <pre className="overflow-x-auto font-mono text-[12px] leading-5">
            {file.patch
              .split("\n")
              .slice(file.binary ? 0 : 2)
              .filter(
                (line) =>
                  !line.startsWith("diff --git") &&
                  !line.startsWith("--- ") &&
                  !line.startsWith("+++ ") &&
                  !line.startsWith("new file") &&
                  !line.startsWith("deleted file"),
              )
              .map((line, index) => (
                <div key={index} className={cn("px-3", lineClass(line))}>
                  {line === "" ? " " : line}
                </div>
              ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
