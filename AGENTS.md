- always run final PR verification in this exact order: `vp run check`, `vp test --run`, then `vp run build`.
- run the three verification commands sequentially. stop on the first failure, fix it, and restart from `vp run check`.
- do not touch vite.config.ts!
- always use typescript v6, for now.
- always read ~/skills/chatgpt_system_prompt.md and ~/skills/clean_code.md and if desiging ~/skills/product_design.md

## Merge pull requests

- always squash merge pull requests.
- never create a `Merge pull request ...` commit.
- do not use a merge commit when the pull request can be squash merged.

## When a pull request is merged to `main` staging

- stop all work in the feature worktree immediately after the merge.
- use `git worktree list` to find the worktree that has `main` checked out.
- change the working directory to the `main` worktree before any post-merge command.
- update the `main` worktree to the merged `origin/main` commit. confirm that the current branch is `main` and that `HEAD` matches `origin/main`.
- never clear D1, generate the schema, migrate, deploy, or make post-merge edits from the merged feature worktree.
- `main` deploys to staging. work on `main` must not deploy to production.
- never run `vp run deploy` from `main` unless the user explicitly requests a production deployment.
- do not create another pull request for the post-merge database reset or staging deployment.
- keep the existing D1 database resource and database ID. never delete and recreate D1 for this workflow.
- clear the existing D1 database in place. remove its application data, schema, and migration records without deleting the D1 resource.
- run `vp run db:generate` after the database is clear.
- run `vp run db:migrate` after schema generation succeeds.
- deploy only staging with `vp run deploy:staging`.
- wait for the Cloudflare checks and deployment to finish.
- validate the staging origin after deployment.
