import { Link } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { Select } from "~/components/ui/input";
import type { EntryView, RefSummary } from "~/lib/types";
import { formatBytes } from "~/lib/utils";

interface TreeLocation {
  owner: string;
  repo: string;
  refName: string;
  path: string;
}

// The API decodes every path segment, so a name with a space or a hash is encoded one segment at a time.
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// Splat for the tree and blob routes: "<ref>/<path>", or just "<ref>" at the root.
export function treeSplat(refName: string, path: string): string {
  return path ? `${refName}/${path}` : refName;
}

export function Breadcrumbs({ owner, repo, refName, path }: TreeLocation) {
  const segments = path ? path.split("/") : [];

  return (
    <nav aria-label="Path" className="flex flex-wrap items-center gap-1 text-sm">
      <Link
        className="text-acid hover:text-paper"
        params={{ owner, repo, _splat: refName }}
        to="/$owner/$repo/tree/$"
      >
        {repo}
      </Link>
      {segments.map((segment, index) => {
        const prefix = segments.slice(0, index + 1).join("/");
        if (index === segments.length - 1) {
          return (
            <span key={prefix}>
              <span className="text-muted">/</span> <span className="text-paper">{segment}</span>
            </span>
          );
        }

        return (
          <span key={prefix}>
            <span className="text-muted">/</span>{" "}
            <Link
              className="text-acid hover:text-paper"
              params={{ owner, repo, _splat: treeSplat(refName, prefix) }}
              to="/$owner/$repo/tree/$"
            >
              {segment}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}

export function BranchSelect({
  branches,
  value,
  onChange,
  id,
  className,
}: {
  branches: RefSummary[];
  value: string;
  onChange: (name: string) => void;
  id?: string;
  className?: string;
}) {
  const known = branches.some((branch) => branch.name === value);

  return (
    <Select
      aria-label={id ? undefined : "Branch"}
      className={className}
      id={id}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {known ? null : <option value={value}>{value}</option>}
      {branches.map((branch) => (
        <option key={branch.name} value={branch.name}>
          {branch.name}
        </option>
      ))}
    </Select>
  );
}

export function FileTable({
  owner,
  repo,
  refName,
  path,
  entries,
}: TreeLocation & { entries: EntryView[] }) {
  if (entries.length === 0) {
    return <p className="hairline bg-ink-2 text-muted px-4 py-6">Empty directory.</p>;
  }

  return (
    <table className="hairline w-full border-collapse text-sm">
      <tbody className="divide-line divide-y">
        {entries.map((entry) => (
          <tr className="hover:bg-ink-2" key={entry.name}>
            <td className="px-4 py-2">
              <EntryName entry={entry} owner={owner} path={path} refName={refName} repo={repo} />
            </td>
            <td className="py-2 pr-4 text-right">
              {entry.kind === "submodule" || entry.kind === "symlink" ? (
                <Badge tone="sky">{entry.kind}</Badge>
              ) : null}
            </td>
            <td className="text-muted w-24 py-2 pr-4 text-right">{formatBytes(entry.size)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EntryName({ entry, owner, repo, refName, path }: TreeLocation & { entry: EntryView }) {
  const childPath = path ? `${path}/${entry.name}` : entry.name;
  if (entry.kind === "dir") {
    return (
      <Link
        className="text-paper hover:text-acid"
        params={{ owner, repo, _splat: treeSplat(refName, childPath) }}
        to="/$owner/$repo/tree/$"
      >
        {entry.name}
        <span className="text-muted">/</span>
      </Link>
    );
  }
  if (entry.kind === "submodule") {
    return (
      <span className="text-muted">
        {entry.name} @ {entry.sha.slice(0, 7)}
      </span>
    );
  }

  return (
    <Link
      className="text-paper hover:text-acid"
      params={{ owner, repo, _splat: treeSplat(refName, childPath) }}
      to="/$owner/$repo/blob/$"
    >
      {entry.name}
    </Link>
  );
}
