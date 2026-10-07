# Review decisions

- The review-agent package has no `test` script, because it is a GitHub Actions worker without tests by the maintainer's decision. ([thread](https://github.com/tunnckoCoreHQ/monarch/pull/143#discussion_r4212410083))
- No guard needed for provider registration because each flue run is a separate process that resolves one model once at startup. ([thread](https://github.com/tunnckoCoreHQ/monarch/pull/143#discussion_r4212410090))
