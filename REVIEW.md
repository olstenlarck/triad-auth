# Review decisions

- The review workflow matches a reply to its thread by the root comment only, because people and agents reply directly to a finding.
- The agent job may succeed when a reply is outside the agent's threads, because the status job recomputes the status from the live threads on every event.
- The status job needs no ancestor check before the compare API, because a force-pushed head reads as diverged or missing and keeps the status pending until a new review.
