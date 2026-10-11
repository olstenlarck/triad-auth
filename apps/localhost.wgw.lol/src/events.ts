import type { ReceiveCommand } from "./git/protocol";

export type QueueEvent =
  | { type: "push"; repoId: string; actorId: string; updates: ReceiveCommand[]; objects: number }
  | {
      type: "pull_request.opened" | "pull_request.merged" | "pull_request.closed";
      repoId: string;
      actorId: string;
      number: number;
      title: string;
    }
  | { type: "repo.imported"; repoId: string; actorId: string; remote: string }
  | { type: "repo.created"; repoId: string; actorId: string };
