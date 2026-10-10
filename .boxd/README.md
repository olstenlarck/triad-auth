# CI on boxd

Monarch's CI runs on [boxd](https://docs.boxd.sh/use-cases/ci-runners) machines. GitHub sends the event and shows the result. One boxd machine, `monarch-ci`, holds the automation in `ci.run.ts`. For every pull request and every push to `master` it restores a fresh isolated machine from the snapshot of master's last green run, checks out the commit, and runs the jobs in `ci.json` in order. Each job reports its own check run, `boxd/check`, `boxd/test`, `boxd/test-solidity`, and `boxd/build`, after `boxd/setup` for the restore, checkout, and install. A green run on `master` saves its machine as the next snapshot, so the next run starts with that commit's `node_modules`, pnpm store, and turbo cache already on disk.

A green run's machine is deleted when the run ends. A failed run's machine is kept for a day, so you can get into the failed state. See [When a run fails](#when-a-run-fails).

The turbo cache in the snapshot is CI's own. Laptops keep their local caches.

Once a night the `cold` schedule runs master's head from a clean tree with `TURBO_FORCE=true`, to catch what a warm snapshot hides. It never promotes.

## Setup, once

The boxd GitHub App must be installed on the `tunnckoCoreHQ` organization with access to this repository. An org admin does that from the GitHub App card on the console's Integrations page. The CLI has no command for the App itself. Once installed, `boxd manage integrations` lists it under the shared connections.

Create the machine:

```sh
boxd machine new monarch-ci --vcpu 4
boxd connect monarch-ci
```

Inside the machine, install the toolchain. The automation runs every step with `bash -lc`, a login shell, and Ubuntu's `.bashrc` returns early for non-interactive shells. So the installers' `.bashrc` additions do nothing for CI, and `PATH` goes in `~/.profile` instead.

```sh
curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
curl -fsSL https://foundry.paradigm.xyz | bash
cat >> ~/.profile <<'EOF'
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$HOME/.local/share/fnm:$HOME/.foundry/bin:$PATH"
eval "$(fnm env)"
EOF
source ~/.profile
foundryup --install v1.7.1

mkdir -p ~/work && cd ~/work
git clone https://github.com/tunnckoCoreHQ/monarch.git && cd monarch
fnm install && fnm default "$(cat .node-version)"
# pnpm's own installer, at the version in packageManager
curl -fsSL https://get.pnpm.io/install.sh |
  PNPM_VERSION="$(node -p "require('./package.json').packageManager.slice(5)")" sh -
CI=1 pnpm install --frozen-lockfile
forge build --root solidity/template
pnpm exec turbo run check test build          # warms the turbo cache
exit
```

Back on the laptop, save the first snapshot:

```sh
boxd snapshots save monarch-ci monarch-master
```

Then put the two files on the machine and start the automation. It stays on `monarch-ci`, which hibernates between events. boxd wakes it when GitHub sends one.

```sh
boxd machine exec monarch-ci -- mkdir -p /home/boxd/ci
boxd machine cp .boxd/ci.json monarch-ci:/home/boxd/ci/ci.json
boxd machine cp .boxd/ci.run.ts monarch-ci:/home/boxd/ci/ci.run.ts
boxd machine exec monarch-ci -- 'cd /home/boxd/ci && run ci.run.ts'
```

## Changing the CI

`ci.json` and `ci.run.ts` live in this repo, but the automation reads its own copies on `monarch-ci`. After editing either one, copy it over and start the file again. Starting the same file again replaces the running automation in place.

```sh
boxd machine cp .boxd/ci.json monarch-ci:/home/boxd/ci/ci.json
boxd machine cp .boxd/ci.run.ts monarch-ci:/home/boxd/ci/ci.run.ts
boxd machine exec monarch-ci -- 'cd /home/boxd/ci && run ci.run.ts'
```

## Watching it

```sh
boxd machine exec monarch-ci -- run jobs             # the automation and its state
boxd machine exec monarch-ci -- run logs <id> -f     # its live log, one line per step
boxd machine list                                    # run machines are named ci-<sha>-<n>
boxd snapshots list                                  # monarch-master and monarch-master-b
```

On GitHub, the Details link of a `boxd/*` check opens the check's own page. It shows a table of the steps with their times and, for a failed step, its last 80 lines of output. There is no link to anything outside GitHub.

## When a run fails

The failed check's summary names the run's machine, for example `ci-3f1c9ab-41237`. The machine is kept for a day, then deleted. It hibernates ten minutes after the run, so until then it costs disk only.

```sh
boxd connect ci-3f1c9ab-41237
```

Inside, the repo is at `/home/boxd/work/monarch` with the failed commit checked out, and the whole run's output is in `/home/boxd/ci.log`, one `=== step` header per step. The log holds only this run. It is emptied when a run starts, so the one in the snapshot never grows. The toolchain, `node_modules`, and the turbo cache are the ones the run used. Rerun the failing command there.

Delete the machine when done rather than waiting out the day. Every machine counts toward the organization's cap.

```sh
boxd machine remove ci-3f1c9ab-41237 -y
```
