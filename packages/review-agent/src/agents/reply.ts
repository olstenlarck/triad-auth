"use agent";
import { useInitialData, useModel, useSandbox, useTool } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

import { github } from "../github";

interface Thread {
  repo: string;
  number: number;
  commentId: number;
  threadId: string;
}

const instructions = `You wrote a finding in a GitHub pull request review of this repository. A person replied in the finding's thread. Decide if you agree with the reply, answer it with the reply tool, and resolve the thread when you agree.

The message gives the pull request, the file and line of the thread, and every comment in the thread. The working directory is the repository at the current head of the pull request. AGENTS.md has the project rules.

How to decide:

1. Read the current code at the file and line, and the code around it. When the reply says that a commit fixed the finding, read that change with git.
2. Agree when the current code fixes the problem, when the reply shows that the finding is wrong, or when the reply gives a valid reason why the finding does not apply, such as a project rule or a stated product decision.
3. Disagree when the problem is still in the current code or the reasoning of the reply is wrong. Show the input or state that still fails.
4. Verify each claim of the reply against the code. Do not agree with a claim that you cannot confirm.
5. When the reply asks a question, answer it. Agree only when the finding needs no more work.

Call the reply tool once. Write the answer plainly: short sentences, active voice, cite files and lines, no filler. Set resolve to true only when you agree.`;

export function Reply() {
  const thread = useInitialData<Thread>();
  useModel("cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6");
  // flue run starts in packages/review-agent; the answer reads the whole repository.
  useSandbox(local({ cwd: "../.." }));
  useTool({
    name: "reply",
    description:
      "Post the answer in the review thread. Set resolve to true when you agree that the finding needs no more work; the thread is then resolved.",
    input: v.object({ body: v.string(), resolve: v.boolean() }),
    async run({ data }) {
      await github(
        `/repos/${thread.repo}/pulls/${thread.number}/comments/${thread.commentId}/replies`,
        { body: data.body },
      );
      if (data.resolve) {
        await github("/graphql", {
          query:
            "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }",
          variables: { id: thread.threadId },
        });
      }
      return {
        output: data.resolve ? "Answered and resolved the thread." : "Answered.",
        terminate: true,
      };
    },
  });
  return instructions;
}
