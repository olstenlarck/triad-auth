"use agent";
import { useModel, useSandbox, useSkill, useTool } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";

import unslop from "../../skills/unslop/SKILL.md";
import { github } from "../github";
import { model } from "../model";

interface Finding {
  thread: string;
  path: string;
  line: number | null;
}

// The workflow sets these for each run. The tools read them here, so the model cannot point a
// tool at another pull request or at a thread that the agent did not open.
const { COMMENT_ID, GITHUB_REPOSITORY, HEAD_SHA, OPEN_THREADS, PR_NUMBER, THREAD_ID } = process.env;
const pull = `/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`;
// Root comment id -> the agent's unresolved finding.
const openFindings: Record<string, Finding> = JSON.parse(OPEN_THREADS ?? "{}");

// The status job finds the agent's reviews by this marker, and the workflow reads the model from it,
// so a model picked with /review stays for the later runs of the pull request.
const marker = `<!-- review-agent model=${model} -->`;

const Comment = v.object({
  path: v.pipe(v.string(), v.description("File path from the repository root.")),
  side: v.optional(
    v.pipe(
      v.picklist(["RIGHT", "LEFT"]),
      v.description(
        "RIGHT (the default) for lines of the new file; LEFT for removed lines, such as in a deleted file.",
      ),
    ),
    "RIGHT",
  ),
  line: v.pipe(
    v.number(),
    v.description("Line in the file version that side names. The last line of a range."),
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

Review decisions:

- Each project folder (apps/<name>, packages/<name>, solidity/<name>, chrome-extensions/<name>) can have a REVIEW.md, and the repository root can have one for everything else. It lists review decisions: findings that do not apply, and why.
- Before you review, read the REVIEW.md and the AGENTS.md of every project that the diff touches when they exist, and the root REVIEW.md. The message also lists the decisions already agreed in this pull request. Do not report a finding that a decision or a project rule rules out.
- Never edit a REVIEW.md yourself. When you resolve a thread because the finding does not apply, pass the decision to the reply tool, and the workflow records it.

When the message asks for a review:

1. Read the diff that the message names with git. Read the changed files and the code that calls or is called by the changed code.
2. Find real defects: wrong behavior, security problems, data loss, broken contracts between changed and unchanged code, missing error handling at system boundaries, violations of the project rules, and tests that do not test what they claim.
3. Verify each finding against the code. Do not report a problem that you cannot show with a concrete input or state. Do not report formatting or lint problems.
4. The message lists your unresolved findings. Do not report them again. When the new commits fix one, call resolve_finding with a short reply that names the fix.
5. Call post_review once, at the end, also when you find nothing.

How to write findings:

- Put each finding in one inline comment on the changed line or line range that causes it. Lines must be inside the diff hunks: on the new file by default, or on removed lines with side LEFT, for example when the finding is about a deleted file.
- Start each comment with the severity in bold: **High**, **Medium**, or **Low**. Then state the problem, the failure scenario, and the fix. Use a GitHub \`suggestion\` block when the fix is a small local edit.
- Start the review body with two or three sentences on what changed. Then add one line with the count of new findings per severity, for example "Findings: 1 High, 2 Medium, 0 Low.", or "No findings." when there are none. Do not repeat the findings in the body.
- If GitHub rejects a comment line, correct the line and call post_review again.

When the message is a reply in one of your threads:

1. Read the current code at the file and line. When the reply says that a commit fixed the finding, read that change with git.
2. Agree when the current code fixes the problem, when the reply shows that the finding is wrong, or when the reply gives a valid reason why the finding does not apply.
3. Disagree when the problem is still in the code or the reasoning is wrong. Show the input or state that still fails. Do not agree with a claim that you cannot confirm.
4. Answer questions. Call reply once, with resolve set to true only when you agree.
5. When you agree because the finding does not apply (for example a "No change." reply with a valid reason, a project rule, or a product decision), also set decision: the rule in one sentence, so a later review does not report the same thing. Leave decision out when the code was fixed.

Writing: activate the unslop skill before you write anything, and apply it to every text you publish: findings, the review body, replies, and decisions. Write plainly: short sentences, active voice, no filler, no praise.`;

export function Reviewer() {
  useModel(model);
  useSkill(unslop);
  // flue run starts in packages/review-agent; the agent works on the whole repository.
  useSandbox(local({ cwd: "../.." }));

  if (COMMENT_ID && THREAD_ID) {
    useTool({
      name: "reply",
      description:
        "Post your answer in the thread. Set resolve to true when you agree that the finding needs no more work; the thread is then resolved. Set decision only when the finding does not apply.",
      input: v.object({
        body: v.string(),
        resolve: v.boolean(),
        decision: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "Only when you resolve because the finding does not apply: the rule in one sentence, for REVIEW.md.",
            ),
          ),
        ),
      }),
      async run({ data }) {
        // The decision rides in the reply as a hidden comment. The status job collects these from the
        // resolved threads and commits them to REVIEW.md once, before it approves.
        const decision =
          data.resolve && data.decision
            ? `\n\n<!-- review-decision: ${data.decision.replaceAll("--", "-").replaceAll(/\s+/g, " ").trim()} -->`
            : "";
        await github(`${pull}/comments/${COMMENT_ID}/replies`, { body: data.body + decision });
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
      const finding = openFindings[String(data.commentId)];
      // Another reviewer's thread, or one already resolved: leave it alone.
      if (!finding) {
        return `Skipped: comment ${data.commentId} is not one of your unresolved findings.`;
      }
      await github(`${pull}/comments/${data.commentId}/replies`, { body: data.body });
      await resolve(finding.thread);
      return "Resolved.";
    },
  });
  useTool({
    name: "post_review",
    description:
      "Publish the review: the summary body and one inline comment per new finding. Call it once, after the review is complete.",
    input: v.object({ body: v.string(), comments: v.array(Comment) }),
    async run({ data }) {
      // Models repeat their open findings despite the instructions, so a comment on the same line as
      // an unresolved finding is dropped here.
      const open = new Set(Object.values(openFindings).map(({ path, line }) => `${path}:${line}`));
      const comments = data.comments.filter(({ path, line }) => !open.has(`${path}:${line}`));
      await github(`${pull}/reviews`, {
        commit_id: HEAD_SHA,
        event: "COMMENT",
        body: `${data.body}\n\n${marker}`,
        comments: comments.map(({ path, side, line, startLine, body }) => ({
          path,
          line,
          side,
          body,
          ...(startLine && startLine < line ? { start_line: startLine, start_side: side } : {}),
        })),
      });
      const dropped = data.comments.length - comments.length;
      return {
        output: `The review is published.${dropped ? ` ${dropped} comments repeated open findings and were dropped.` : ""}`,
        terminate: true,
      };
    },
  });
  return instructions;
}
