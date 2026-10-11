import { createFileRoute, getRouteApi, notFound, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Breadcrumbs, encodePath } from "~/components/file-table";
import { Button } from "~/components/ui/button";
import { Input, Label, Textarea } from "~/components/ui/input";
import { callApi } from "~/lib/server";
import type { FileView } from "~/lib/types";
import { formatBytes, mutate } from "~/lib/utils";

const repoApi = getRouteApi("/$owner/$repo");

// The splat is "<ref>/<path>". Branch names never contain a slash here, so the ref is the first segment.
export const Route = createFileRoute("/$owner/$repo/blob/$")({
  loader: async ({ params }) => {
    const splat = params._splat ?? "";
    const [refName, ...rest] = splat.split("/");
    const path = rest.join("/");
    if (!refName || !path) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }

    const api = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const result = await callApi<FileView>(`${api}/blob/${encodePath(splat)}`);
    if (result.status === 404) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }
    if (!result.data) {
      throw new Error(result.error ?? "request failed");
    }

    return { refName, path, file: result.data };
  },
  component: Blob,
});

function Blob() {
  const data = repoApi.useLoaderData();
  const { refName, path, file } = Route.useLoaderData();
  const { owner, repo } = Route.useParams();
  const [editing, setEditing] = useState(false);
  const api = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const rawUrl = `${api}/raw/${encodePath(`${refName}/${path}`)}`;
  const lines = file.text === null ? [] : file.text.replace(/\n$/, "").split("\n");
  // Writes go to a branch head, so a tag or a bare sha gets no editor.
  const editable =
    data.permissions.write &&
    file.text !== null &&
    data.refs.branches.some((branch) => branch.name === refName);

  return (
    <div className="py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Breadcrumbs owner={owner} path={path} refName={refName} repo={repo} />
        <div className="flex flex-wrap items-center gap-4">
          <span className="eyebrow">
            {file.text === null ? "binary" : `${lines.length} lines`} · {formatBytes(file.size)} ·{" "}
            {refName}
          </span>
          <a className="eyebrow hover:text-paper" href={rawUrl}>
            raw
          </a>
          {editable ? (
            <Button onClick={() => setEditing(!editing)} size="sm" variant="outline">
              {editing ? "Cancel" : "Edit"}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        {editing && file.text !== null ? (
          <Editor
            api={api}
            branch={refName}
            onSaved={() => setEditing(false)}
            path={path}
            text={file.text}
          />
        ) : null}
        {!editing && file.text === null ? (
          <p className="hairline bg-ink-2 text-muted px-4 py-6">
            Binary file, {formatBytes(file.size)}.{" "}
            <a className="text-acid" href={rawUrl}>
              Download the raw bytes.
            </a>
          </p>
        ) : null}
        {!editing && file.text !== null ? (
          <div className="hairline bg-ink-2 overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[12px]">
              <tbody>
                {lines.map((line, index) => (
                  <tr id={`L${index + 1}`} key={index}>
                    <td className="border-line text-muted w-12 border-r px-2 text-right align-top select-none">
                      {index + 1}
                    </td>
                    <td className="px-3 whitespace-pre">{line}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Editor({
  api,
  path,
  branch,
  text,
  onSaved,
}: {
  api: string;
  path: string;
  branch: string;
  text: string;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [content, setContent] = useState(text);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await mutate(`${api}/contents/${encodePath(path)}`, {
        method: "PUT",
        body: { content, message, branch },
      });
      await router.invalidate();
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "failed");
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Textarea
        aria-label="File content"
        className="min-h-[60vh] text-[12px] whitespace-pre"
        onChange={(event) => setContent(event.target.value)}
        spellCheck={false}
        value={content}
      />
      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <div>
          <Label htmlFor="commit-message">Commit message</Label>
          <Input
            id="commit-message"
            onChange={(event) => setMessage(event.target.value)}
            placeholder={`Update ${path}`}
            value={message}
          />
        </div>
        <div className="self-end">
          <Button disabled={busy} type="submit">
            {busy ? "Saving" : `Commit to ${branch}`}
          </Button>
        </div>
      </div>
      {error ? <p className="text-blood">{error}</p> : null}
    </form>
  );
}
