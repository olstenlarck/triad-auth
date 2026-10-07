"use agent";
import { useModel, useSandbox, useTool } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

import { github } from "../github";
import { model } from "../model";

// The workflow sets these for each run. The tools read them here, so the model cannot point a
// tool at another pull request or at a thread that the agent did not open.
const { COMMENT_ID, GITHUB_REPOSITORY, HEAD_SHA, OPEN_THREADS, PR_NUMBER, THREAD_ID } = process.env;
const pull = `/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`;
// Root comment id -> thread id of the agent's unresolved threads.
const openThreads: Record<string, string> = JSON.parse(OPEN_THREADS ?? "{}");

// The status job finds the agent's reviews by this marker, and the workflow reads the model from it,
// so a model picked with /review stays for the later runs of the pull request.
const marker = `<!-- review-agent model=${model} -->`;

const Comment = v.object({
  path: v.pipe(v.string(), v.description("File path from the repository root.")),
  line: v.pipe(
    v.number(),
    v.description("Line in the new version of the file. The last line of a range."),
  ),
  startLine: v.optional(v.pipe(v.number(), v.description("First line of a multi-line range."))),
  body: v.pipe(v.string(), v.description("The finding, in GitHub Markdown.")),
});

const resolve = (threadId: string) =>
  github("/graphql", {
    query:
      "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }",
    variables: { id: threadId },
  });

const instructions = `You review GitHub pull requests of this repository, and you answer replies to your findings. The working directory is the repository at the head of the pull request. AGENTS.md has the project rules.

Decisions file:

- Each project folder (apps/<name>, packages/<name>, solidity/<name>, chrome-extensions/<name>) can have a REVIEW.md, and the repository root can have one for everything else. It lists review decisions: findings that do not apply, and why.
- Before you review, read the REVIEW.md of every project that the diff touches, and the root one. Do not report a finding that a decision rules out.
- When you resolve a thread because the reply shows that the finding does not apply (for example a "No change." reply with a valid reason, a project rule, or a product decision), add one bullet to the REVIEW.md of the project that holds the file, or to the root REVIEW.md. State the decision as a rule in one sentence, then add a link to the thread. Create the file with the heading "# Review decisions" when it does not exist. Edit no other file.
- Do not record a decision when the code was fixed.

When the message asks for a review:

1. Read the diff that the message names with git. Read the changed files and the code that calls or is called by the changed code.
2. Find real defects: wrong behavior, security problems, data loss, broken contracts between changed and unchanged code, missing error handling at system boundaries, violations of the project rules, and tests that do not test what they claim.
3. Verify each finding against the code. Do not report a problem that you cannot show with a concrete input or state. Do not report formatting or lint problems.
4. The message lists your unresolved findings. Do not report them again. When the new commits fix one, call resolve_finding with a short reply that names the fix.
5. Call post_review once, at the end, also when you find nothing.

How to write findings:

- Put each finding in one inline comment on the changed line or line range that causes it. Lines must be inside the diff hunks of the new file.
- Start each comment with the severity in bold: **High**, **Medium**, or **Low**. Then state the problem, the failure scenario, and the fix. Use a GitHub \`suggestion\` block when the fix is a small local edit.
- In the review body, summarize what changed in two or three sentences, then give the number of findings by severity.
- If GitHub rejects a comment line, correct the line and call post_review again.

When the message is a reply in one of your threads:

1. Read the current code at the file and line. When the reply says that a commit fixed the finding, read that change with git.
2. Agree when the current code fixes the problem, when the reply shows that the finding is wrong, or when the reply gives a valid reason why the finding does not apply.
3. Disagree when the problem is still in the code or the reasoning is wrong. Show the input or state that still fails. Do not agree with a claim that you cannot confirm.
4. Answer questions. Call reply once, with resolve set to true only when you agree.

Write plainly: short sentences, active voice, no filler, no praise.`;

export function Reviewer() {
  useModel(model);
  // flue run starts in packages/review-agent; the agent works on the whole repository.
  useSandbox(local({ cwd: "../.." }));

  if (COMMENT_ID && THREAD_ID) {
    useTool({
      name: "reply",
      description:
        "Post your answer in the thread. Set resolve to true when you agree that the finding needs no more work; the thread is then resolved.",
      input: v.object({ body: v.string(), resolve: v.boolean() }),
      async run({ data }) {
        await github(`${pull}/comments/${COMMENT_ID}/replies`, { body: data.body });
        if (data.resolve) {
          await resolve(THREAD_ID);
        }
        return {
          output: data.resolve ? "Answered and resolved the thread." : "Answered.",
          terminate: true,
        };
      },
    });
    return instructions;
  }

  useTool({
    name: "resolve_finding",
    description:
      "Resolve one of your unresolved findings that the new commits fixed, with a short reply that names the fix.",
    input: v.object({
      commentId: v.pipe(v.number(), v.description("Comment id of the finding, from the message.")),
      body: v.string(),
    }),
    async run({ data }) {
      const threadId = openThreads[String(data.commentId)];
      if (!threadId) {
        throw new Error(`Comment ${data.commentId} is not one of your unresolved findings.`);
      }
      await github(`${pull}/comments/${data.commentId}/replies`, { body: data.body });
      await resolve(threadId);
      return "Resolved.";
    },
  });
  useTool({
    name: "post_review",
    description:
      "Publish the review: the summary body and one inline comment per new finding. Call it once, after the review is complete.",
    input: v.object({ body: v.string(), comments: v.array(Comment) }),
    async run({ data }) {
      await github(`${pull}/reviews`, {
        commit_id: HEAD_SHA,
        event: "COMMENT",
        body: `${data.body}\n\n${marker}`,
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
