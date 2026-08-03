# Autonomous frontier loop

The frontier loop works through the open sub-issues of spec issue #40 in dependency order. Each ticket gets a fresh Pi process and an isolated Git worktree.

For every available frontier ticket, it:

1. claims the issue;
2. invokes `/skill:implement` in a fresh, non-persistent Pi session;
3. runs `npm ci --ignore-scripts`, the syntax checks, and the full test suite independently;
4. invokes an independent two-axis Standards/Spec reviewer in another fresh Pi session;
5. gives the implementation agent up to two remediation passes when validation fails;
6. pushes a ticket branch and opens a closing pull request;
7. waits for registered GitHub checks and merges the pull request;
8. fetches the new default-branch state and selects the next unblocked, unassigned sub-issue.

The loop stops successfully when every child of #40 is closed. It stops on an unrecoverable implementation, validation, GitHub, or merge failure and preserves that ticket's worktree and logs for inspection. Starting it again resumes the preserved ticket.

## Safety boundary

Starting the loop authorizes Pi and the orchestration script to edit code, run local commands, push branches, open pull requests, merge passing pull requests, and close their linked issues. It does not close the parent spec issue.

The control checkout must be clean and pushed to the remote default branch before its first start. On a later restart, a clean checkout that is merely behind the remote is fast-forwarded automatically. Commit and push the loop itself, `CONTEXT.md`, and any other local work before starting. This prevents local planning changes from being silently omitted from ticket branches.

Required commands and authentication:

- tmux;
- Pi with a configured model/provider;
- Git and npm;
- GitHub CLI authenticated with permission to assign issues, push branches, create pull requests, and merge them.

## Commands

Start the detached loop:

```sh
npm run frontier:start
```

Check progress without attaching:

```sh
npm run frontier:status
```

The status report includes the current phase, ticket, pull request, worktree, error, live GitHub frontier, completion count, and recent ticket log.

Watch the tmux session:

```sh
npm run frontier:attach
```

Detach without stopping it using the normal tmux prefix followed by `d`.

Stop after interrupting the current operation:

```sh
npm run frontier:stop
```

If a ticket exhausts its remediation attempts, inspect the worktree and issue log shown by `frontier:status`. After correcting the failure or leaving useful work in place, run `frontier:start` again; the loop resumes the recorded ticket and asks a fresh implementation agent to finish it.

## Overrides

The scripts default to parent issue #40 and tmux session `porcupi-frontier-40`. A different parent can be supplied directly:

```sh
node scripts/frontier-loop.mjs start --parent 123
node scripts/frontier-loop.mjs status --parent 123
```

The following environment variables are also supported:

- `PORCUPI_FRONTIER_PARENT` — default parent issue number;
- `PORCUPI_FRONTIER_SESSION` — tmux session name;
- `PORCUPI_FRONTIER_DIR` — state, logs, and worktree root.

Runtime state is stored beneath the ignored `artifacts/` directory by default.
