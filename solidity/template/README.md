# name of the project

Template solidity project for this monorepo with foundry and deps managed by Pnpm.

<!-- details for the project -->

## Build & Testing

Project is managed by Pnpm, VitePlus, and Foundry.

From the root of the monorepo:

```
# solidity tool chain: fmt/lint/test/build/checks
pnpm run solidity:check

# run only glyph protocol
turbo run fmt --filter=glyph-protocol
turbo run lint --filter=glyph-protocol
turbo run test --filter=glyph-protocol
turbo run build --filter=glyph-protocol

# or just `check` it runs everything needed
turbo run check --filter=glyph-protocol
```

from this project's folder

```
pnpm run fmt
pnpm run lint
pnpm run test
pnpm run build

# or just
pnpm run check
```

## License

Apache-2.0
