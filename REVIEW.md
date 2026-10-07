# Review decisions

- The review workflow matches a reply to its thread by the root comment only, because people and agents reply directly to a finding, never to a reply. ([thread](https://github.com/tunnckoCoreHQ/monarch/pull/143#discussion_r4212410054))
- The agent job exits success when the reply thread is not the agent's, because the status job recomputes status from live thread state on every event, so a skipped agent job would not change the computed status. ([thread](https://github.com/tunnckoCoreHQ/monarch/pull/143#discussion_r4212410096))
- The status job's `covered` check does not need an explicit ancestor check before calling the compare API. After a force push, the API returns `diverged` status or errors, both leaving `covered` false so the status stays pending until the agent reviews the new head. This is the intended behavior. ([thread](https://github.com/tunnckoCoreHQ/monarch/pull/143#discussion_r4212410070))
