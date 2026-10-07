"use agent";
import { useInitialData, useModel, useSandbox, useTool } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

import { github } from "../github";

interface Pull {
  repo: string;
  number: number;
  head: string;
}

const Comment = v.object({
  path: v.pipe(v.string(), v.description("File path from the repository root.")),
  line: v.pipe(
    v.number(),
    v.description("Line in the new version of the file. The last line of a range."),
  ),
  startLine: v.optional(v.pipe(v.number(), v.description("First line of a multi-line range."))),
  body: v.pipe(v.string(), v.description("The finding, in GitHub Markdown.")),
});

const instructions = `You review one GitHub pull request of this repository and publish the review with the post_review tool.

The message gives the pull request number, title, description, and the base and head commits. The working directory is the repository at the head commit.

How to review:

1. Read AGENTS.md. Its rules are the project rules.
2. Read the full diff with \`git diff <base>...<head>\`. Read the changed files and the code that calls or is called by the changed code.
3. Find real defects: wrong behavior, security problems, data loss, broken contracts between changed and unchanged code, missing error handling at system boundaries, violations of the project rules, and tests that do not test what they claim.
4. Verify each finding against the code before you report it. Do not report a problem that you cannot show with a concrete input or state. Do not report formatting or lint problems; the toolchain catches them.
5. Call post_review once, at the end.

How to write the review:

- Put each finding in one inline comment on the changed line or line range that causes it. Lines must be inside the diff hunks of the new file.
- Start each comment with the severity in bold: **High**, **Medium**, or **Low**. Then state the problem, the failure scenario, and the fix. Use a GitHub \`suggestion\` block when the fix is a small local edit.
- In the review body, summarize what the pull request changes in two or three sentences, then list the number of findings by severity. When you find no problems, say so.
- Write plainly: short sentences, active voice, no filler, no praise.
- If GitHub rejects a comment line, correct the line and call post_review again.`;

export function Review() {
  const pull = useInitialData<Pull>();
  useModel("cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6");
  // flue run starts in packages/review-agent; the review reads the whole repository.
  useSandbox(local({ cwd: "../.." }));
  useTool({
    name: "post_review",
    description:
      "Publish the review on the pull request: the summary body and one inline comment per finding. Call it once, after the review is complete.",
    input: v.object({ body: v.string(), comments: v.array(Comment) }),
    async run({ data }) {
      await github(`/repos/${pull.repo}/pulls/${pull.number}/reviews`, {
        commit_id: pull.head,
        event: "COMMENT",
        body: data.body,
        comments: data.comments.map(({ path, line, startLine, body }) => ({
          path,
          line,
          side: "RIGHT",
          body,
          ...(startLine && startLine < line ? { start_line: startLine, start_side: "RIGHT" } : {}),
        })),
      });
      return { output: "The review is published.", terminate: true };
    },
  });
  return instructions;
}
