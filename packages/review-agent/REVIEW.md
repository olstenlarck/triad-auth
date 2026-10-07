# Review decisions

- The review-agent package has no `test` script, by the maintainer's decision.
- The agent needs no guard against registering a provider twice, because each `flue run` resolves one model once.
- Tools need no automatic retries for GitHub calls: Flue returns tool errors to the model, and retried POST calls would post duplicates.
