# PorcuPi

PorcuPi adds individual resource selection to Pi's Git package lifecycle and builds an isolated Managed Pi from explicitly selected source patches, without modifying Stock Pi.

PorcuPi v1 targets macOS and Linux. The current implementation installs and launches the release-pinned, zero-Patch Managed Pi foundation and adds individually selected Pi resources from exact Git commits. Patch selection arrives in a subsequent v1 tracer bullet.

## Install the zero-Patch Managed Pi

Prerequisites: Git, npm, and Node.js 22.19 or newer.

From a trusted PorcuPi checkout, run:

```sh
./install.sh
```

The guided installer shows the exact Pi Base commit before doing work. Press Enter to install or Escape to cancel. It:

1. preserves Stock Pi and does not create or replace a `pi` command;
2. verifies official Pi v0.81.1 at commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`;
3. installs the exact npm lock with lifecycle scripts disabled, hydrates and validates release-pinned model data from the exact official Pi AI package, builds offline, and runs fixed public CLI checks in an isolated home;
4. publishes an immutable, receipt-bound Managed Pi Composition and atomically activates it; and
5. creates `~/.local/bin/porcupi`, refusing any existing file or symlink at that path.

Add `~/.local/bin` to `PATH` if the installer reports that it is missing. Then launch Managed Pi with:

```sh
porcupi
```

Ordinary Pi arguments are forwarded unchanged:

```sh
porcupi --version
```

## Add Pi resources from Git

Use a Pi-compatible Git source, optionally with a branch, tag, or full commit:

```sh
porcupi add https://github.com/example/pi-resources@main
porcupi add git:github.com/example/pi-resources@v1
porcupi add # prompts for the source
```

PorcuPi resolves the requested ref to one full commit before showing the three-page Artifact selection, global Installation Scope, and review flow. Use arrows or `j`/`k` to move, Space or Enter to toggle, `a`/`d` to select or deselect all, `n`/Right/`l` to advance, `h`/Left to return, and Escape to cancel.

Confirmed Skills, Extensions, Prompts, and Themes become one exact-commit, minimally filtered global Pi Git package. Pi owns checkout, npm dependencies, updates, and loading. Re-adding the same Source Repository reviews and replaces its complete prior PorcuPi selection. Project Installation Scope and unified management are delivered by the next tracer bullet.

Git content and fixed build commands run with your user authority. Exact commits, SHA-256 values, and receipts support reproducibility and local integrity checks; they do not authenticate a publisher or provide a sandbox. Use an OS, VM, or container boundary when isolation is required.

## Development

Run the external-process acceptance suite with one command:

```sh
npm test
```

The tests drive the guided installer and `porcupi add` through pseudo-terminals in isolated homes, using deterministic local Git Pi Base, Source Repository, and Pi package-lifecycle fixtures.

The build specification and remaining tracer bullets are tracked in [PorcuPi v1 issue #12](https://github.com/taylorrowser/PorcuPi/issues/12).
