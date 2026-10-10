# CI on boxd

Monarch's CI runs on [boxd](https://docs.boxd.sh/use-cases/ci-runners) machines. GitHub sends the event and shows the result. One boxd machine, `monarch-ci`, holds the automation in `ci.run.ts`. For every pull request and every push to `master` it restores a fresh isolated machine from the snapshot of master's last green run, checks out the commit, and runs the jobs in `ci.json` in order. Each job reports its own check run, `boxd/check`, `boxd/test`, `boxd/test-solidity`, and `boxd/build`, after `boxd/setup` for the restore, checkout, and install. A green run on `master` saves its machine as the next snapshot, so the next run starts with that commit's `node_modules`, pnpm store, and turbo cache already on disk. Every other machine is deleted when its run ends.

The turbo cache in the snapshot is CI's own. Laptops keep their local caches.

Once a night the `cold` schedule runs master's head from a clean tree with `TURBO_FORCE=true`, to catch what a warm snapshot hides. It never promotes.

## Setup, once

The boxd GitHub App must be installed on the `tunnckoCoreHQ` organization with access to this repository. An org admin does that from the console's Integrations page.

Create the machine and the first snapshot. Tools go under `/usr/local` because the automation runs steps with `bash -lc`, and Ubuntu's `.bashrc` returns early for non-interactive shells.

```sh
boxd machine new monarch-ci --vcpu 4
boxd connect monarch-ci
```

Inside the machine:

```sh
curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz |
  sudo tar -xJ -C /usr/local --strip-components=1
sudo corepack enable
curl -fsSL https://foundry.paradigm.xyz | bash
~/.foundry/bin/foundryup --install v1.7.1
sudo ln -s ~/.foundry/bin/* /usr/local/bin/

mkdir -p ~/work && cd ~/work
gh repo clone tunnckoCoreHQ/monarch && cd monarch
CI=1 pnpm install --frozen-lockfile
forge build --root solidity/template
pnpm exec turbo run check test build          # warms the turbo cache
exit
```

Back on the laptop:

```sh
boxd snapshots save monarch-ci monarch-master
```

Start the automation on the same machine. It stays there, hibernated between events.

```sh
boxd machine exec monarch-ci -- mkdir -p /home/boxd/ci
boxd machine cp .boxd/ci.json monarch-ci:/home/boxd/ci/ci.json
boxd machine cp .boxd/ci.run.ts monarch-ci:/home/boxd/ci/ci.run.ts
boxd machine exec monarch-ci -- 'cd /home/boxd/ci && run ci.run.ts'
```

## Day to day

Re-run the last block after changing `ci.json` or `ci.run.ts`. Re-running the file replaces the job in place.

```sh
boxd machine exec monarch-ci -- run jobs             # the automation and its state
boxd machine exec monarch-ci -- run logs <id> -f     # the live log, one line per step
boxd snapshots list                                  # monarch-master and monarch-master-b
```

A failed check's summary ends with the last 80 lines of the failing step. To debug in the exact environment, restore the current snapshot into a machine of your own and check out the commit:

```sh
boxd machine new scratch --from-snapshot monarch-master
boxd connect scratch
```

Delete it when done. It counts toward the organization's machine cap.
