import { createFileRoute, getRouteApi, notFound, useNavigate } from "@tanstack/react-router";

import {
  BranchSelect,
  Breadcrumbs,
  FileTable,
  encodePath,
  treeSplat,
} from "~/components/file-table";
import { callApi } from "~/lib/server";
import type { EntryView } from "~/lib/types";

const repoApi = getRouteApi("/$owner/$repo");

// The splat is "<ref>/<path>". Branch names never contain a slash here, so the ref is the first segment.
export const Route = createFileRoute("/$owner/$repo/tree/$")({
  loader: async ({ params }) => {
    const splat = params._splat ?? "";
    const [refName, ...rest] = splat.split("/");
    if (!refName) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }

    const api = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const result = await callApi<{ ref: string; path: string; entries: EntryView[] }>(
      `${api}/tree/${encodePath(splat)}`,
    );
    if (result.status === 404) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }
    if (!result.data) {
      throw new Error(result.error ?? "request failed");
    }

    return { refName, path: rest.join("/"), entries: result.data.entries };
  },
  component: Tree,
});

function Tree() {
  const data = repoApi.useLoaderData();
  const { refName, path, entries } = Route.useLoaderData();
  const { owner, repo } = Route.useParams();
  const navigate = useNavigate();

  return (
    <div className="py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Breadcrumbs owner={owner} path={path} refName={refName} repo={repo} />
        <BranchSelect
          branches={data.refs.branches}
          className="w-auto min-w-48"
          onChange={(name) => {
            void navigate({
              to: "/$owner/$repo/tree/$",
              params: { owner, repo, _splat: treeSplat(name, path) },
            });
          }}
          value={refName}
        />
      </div>
      <div className="mt-6">
        <FileTable entries={entries} owner={owner} path={path} refName={refName} repo={repo} />
      </div>
    </div>
  );
}
