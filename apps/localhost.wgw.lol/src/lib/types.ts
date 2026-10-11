// Shapes returned by the REST API under /api/repos. Loaders and pages share these.

export interface RepoInfo {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  visibility: "public" | "private";
  default_branch: string;
  imported_from: string | null;
  import_status: string | null;
  created_at: number;
  updated_at: number;
  pushed_at: number | null;
}

export interface RefSummary {
  name: string;
  sha: string;
}

export interface RepoData {
  repo: RepoInfo;
  clone_url: string;
  public_clone_url: string | null;
  permissions: {
    role: "read" | "write" | "admin" | null;
    read: boolean;
    write: boolean;
    admin: boolean;
  };
  refs: { head: string; branches: RefSummary[]; tags: RefSummary[] };
  stats: { objects: number; bytes: number; refs: number };
  import: { status: "idle" | "running" | "done" | "failed"; message: string; updatedAt: number };
  path_rules: Array<{ pattern: string; visibility: "public" | "private" }>;
}

export interface Person {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export interface CommitView {
  sha: string;
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export interface EntryView {
  mode: string;
  name: string;
  sha: string;
  kind: "dir" | "file" | "submodule" | "symlink";
  size?: number;
}

export interface FileView {
  ref: string;
  path: string;
  sha: string;
  size: number;
  binary: boolean;
  text: string | null;
}

export interface ChangeView {
  path: string;
  status: "added" | "removed" | "modified";
  oldSha?: string;
  newSha?: string;
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  oldText: string | null;
  newText: string | null;
}

export interface CompareView {
  base: string;
  head: string;
  mergeBase: string | null;
  ahead: number;
  changes: ChangeView[];
  commits: CommitView[];
}

export interface PullRequestView {
  id: string;
  number: number;
  title: string;
  body: string;
  author_handle: string;
  base_ref: string;
  head_ref: string;
  state: "open" | "merged" | "closed";
  merge_sha: string | null;
  ai_summary: string | null;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
}

export interface CommentView {
  id: string;
  author_handle: string;
  body: string;
  created_at: number;
}

export interface EventView {
  id: string;
  type: string;
  actor_handle: string | null;
  payload: string;
  summary: string | null;
  created_at: number;
}

export interface EnvironmentView {
  name: string;
  created_at: number;
  vars: Array<{ key: string; secret: boolean; updated_at: number }>;
}

export interface Collaborator {
  handle: string;
  role: "read" | "write" | "admin";
  user_id: string;
}
