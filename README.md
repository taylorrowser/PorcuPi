# PorcuPi

PorcuPi adds individual resource selection to Pi's Git package lifecycle and builds an isolated Managed Pi from explicitly selected source patches, without modifying Stock Pi.

PorcuPi v1 targets macOS and Linux. The current npm-enabled release is v0.2.0. It installs and launches a release-pinned Managed Pi, manages individually selected Pi resources and Patches from exact Git commits, atomically applies pending Patch intent as immutable compositions, and retains one verified local Composition for rollback.

## Install or upgrade with Release Installation

Run the official npm artifact at one exact version:

```sh
npx --yes porcupi@0.2.0
```

The exact version is deliberate: it cannot silently resolve to a later PorcuPi release. Release Installation remains **networked** and **interactive**, supports **macOS and Linux** only, and requires **Git, npm, and Node.js 22.19 or newer**. npm delivers and starts the one-shot installer but does not own the installed PorcuPi lifecycle; GitHub remains the canonical source and release record.

Existing `pi-wait-for-user` Managed Installation users must first follow the [old-manager uninstall and manual migration procedure](docs/migration-from-pi-wait-for-user.md); PorcuPi does not adopt legacy state or payloads. An intact PorcuPi v0.1.0 installation can instead run the same exact v0.2.0 command for a guided, readiness-checked upgrade. Historical [v0.1.0 installation documentation](docs/install.md), release records, and artifacts remain immutable, and v0.1.0 was not retroactively published to npm.

See the complete [Release Installation guide](docs/release-installation.md) for fresh installation, v0.1.0 upgrade, Stock Pi and collision behavior, interruption recovery, trust limits, and release evidence.

The exact-tag source path remains the advanced audit and fallback entrance rather than the primary journey:

```sh
git clone --branch v0.2.0 --depth 1 https://github.com/taylorrowser/PorcuPi.git
cd PorcuPi
git rev-parse HEAD
./install.sh
```

Both entrances invoke the same guided Release Installation. The three-page flow shows the exact Pi Base commit, asks whether PorcuPi should own the `pi` command, and reviews the result. The choice defaults to No; use arrows or `y`/`n`, press Enter to continue/install, or Escape to cancel. It:

1. preserves Stock Pi and, by default, does not create or replace a `pi` command;
2. verifies official Pi v0.81.1 at commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`;
3. installs the exact npm lock with lifecycle scripts disabled, hydrates and validates release-pinned model data from the exact official Pi AI package, builds offline, and runs fixed public CLI checks in an isolated home;
4. publishes an immutable, receipt-bound Managed Pi Composition and atomically activates it; and
5. creates a receipt-bound `~/.local/bin/porcupi`, refusing any existing file or symlink at that path; and
6. only after that complete launch path exists, optionally publishes a receipt-bound `~/.local/bin/pi` alias.

Add `~/.local/bin` to `PATH` if the installer reports that it is missing. Then launch Managed Pi with:

```sh
porcupi
```

Ordinary Pi arguments are forwarded unchanged:

```sh
porcupi --version
```

## Choose `pi` command ownership

The installer defaults to preserving normal shell ownership of `pi`. Change the choice later with immediate explicit lifecycle commands:

```sh
porcupi pi enable
porcupi pi disable
```

Enable publishes only `~/.local/bin/pi`, and only after verifying the stable `porcupi` launcher and active Managed Pi. The alias invokes that exact stable launcher, so it follows the same fail-closed Composition checks and process-lease path. PorcuPi refuses every existing unowned file, symlink, directory, or other collision at the alias path without overwrite, backup, rename, adoption, or force behavior.

The alias has a strict receipt binding its absolute path, regular-file kind, mode, size, SHA-256, and PorcuPi ownership type. Disable removes only the unchanged matching alias and receipt. Modified, malformed, traversing, foreign, or symlink-substituted entries are reported and untouched. Owner-marked transitions make interrupted enable and disable retries converge without treating location or matching bytes alone as ownership.

Disabling never removes `porcupi`. Afterward, the shell may resolve an independently installed Stock Pi normally; PorcuPi neither stores nor executes Stock Pi as fallback. If another `pi` appears earlier on PATH while ownership is enabled, PorcuPi reports the resolved path and advises placing `~/.local/bin` earlier rather than editing PATH itself.

## Add Pi resources from Git

Use the complete [Source Repository guide](docs/source-guide.md) to consume a source or make Extensions, Skills, prompt templates, Themes, and Patches discoverable through PorcuPi.

Use a Pi-compatible Git source, optionally with a branch, tag, or full commit:

```sh
porcupi add https://github.com/example/pi-resources@main
porcupi add git:github.com/example/pi-resources@v1
porcupi add # prompts for the source
```

PorcuPi resolves the requested ref to one full commit before showing the three-page Artifact selection, Installation Scope, and review flow. Use arrows or `j`/`k` to move, Space or Enter to toggle, `a`/`d` to select or deselect all, `n`/Right/`l` to advance, `h`/Left to return, and Escape to cancel. Each selected resource can be global or local to the current project; when no current project directory is available, the scope page clearly disables project assignment.

Confirmed Skills, Extensions, Prompts, and Themes become exact-commit, minimally filtered Pi Git packages in Pi's documented global or `.pi/settings.json` project configuration. When the same Source Repository has both global and project selections, the project entry is a delta so selected global resources continue to load under Pi's scope and deduplication rules. PorcuPi invokes Pi with `-l` for project realization but never supplies `--approve`, writes `trust.json`, or otherwise answers project trust. Pi owns checkout, npm dependencies, updates, loading, precedence, and trust. Full commit refs remain pinned during ordinary Pi package updates; advancing a source requires another explicit add/review operation.

PorcuPi also recursively discovers tracked regular `*.patch` files beneath the Source Repository's root `patches/`. It rejects symbolic links, Git submodules, unsafe paths, non-regular files, and boundary escapes, and saves each selected Patch's full structural path and SHA-256 at the exact source commit. Patches appear beside Pi resources in add and manage, but never receive an Installation Scope or enter Pi package settings. Saving Patch intent reports it as pending and never rebuilds or changes the active Managed Pi Composition.

A source may optionally add display text and exact Pi Base compatibility through the versioned, unknown-field-rejecting root `porcupi.json` schema documented in [ADR 0004](docs/adr/0004-narrow-patch-metadata.md). Missing or invalid metadata leaves convention-discovered Patches available under PorcuPi's fixed pipeline. Metadata cannot add Patch paths, dependencies, hooks, scripts, ordering, build recipes, verifiers, Artifact Sets, or solver behavior.

Re-adding the same Source Repository reviews and replaces its complete prior PorcuPi selection. To remove retained resources or move them between scopes without resolving a new source commit, run:

```sh
porcupi manage
```

`manage` uses the same three-page selection, scope, and review pattern across all retained Source Repositories. Confirmed changes preserve unrelated Pi settings and never rebuild or activate Managed Pi.

## Apply selected Patches

Run the guided apply flow after reviewing Patch Selection Intent:

```sh
porcupi apply
```

Apply previews the complete deterministic order by canonical Source Repository locator and source-relative path, including each exact commit-bound digest, then requires Enter or Space confirmation. Escape or Ctrl-C cancels without changing activation.

After confirmation, PorcuPi resolves each exact source commit again, verifies every selected regular file and SHA-256, and stages those exact bytes. It checks the complete series sequentially in an isolated Pi Base checkout before applying the same staged bytes to a separate build checkout. The candidate then runs PorcuPi's one fixed dependency-installation, pinned-model-data, offline-build, public-conformance, exact-version, and isolated-home smoke recipe. Patch sources cannot supply commands, hooks, order overrides, verifiers, or force behavior.

A successful candidate receives matching embedded and central receipts binding the PorcuPi version, exact Pi Base, ordered Patch identities, fixed recipe, platform/architecture, required executable, and complete normalized payload inventory. PorcuPi publishes the read-only composition before atomically selecting it and retaining the former active composition as `previous`. Zero selected Patches returns Managed Pi to the exact Pi Base. Applying the fully verified active Patch identity is a no-op and does not rebuild. Any pre-activation failure leaves active and previous unchanged.

Git content and fixed build commands run with your user authority. Exact commits, SHA-256 values, and receipts support reproducibility and local integrity checks; they do not authenticate a publisher or provide a sandbox. Use an OS, VM, or container boundary when isolation is required.

## Roll back locally

Run the guided rollback flow to inspect the active and optional previous Managed Pi Composition:

```sh
porcupi rollback
```

When a previous Composition exists, rollback requires Enter or Space confirmation, fully verifies its matching receipts and complete payload inventory, and atomically swaps active and previous. Escape or Ctrl-C cancels. With no retained target, the flow reports that nothing can be changed. Rollback performs no fetch or build and leaves Pi resource and Patch Selection Intent unchanged; if Patch intent is pending afterward, a later `porcupi apply` can restore it.

Install, apply, rollback, future command-ownership changes, cleanup, and uninstall share one lifecycle lock. Ordinary Managed Pi launches continue without taking that lock. Each launch claims an owner-marked Composition lease before resolving its payload and retains the lease for the child Pi process lifetime.

After activation changes, PorcuPi retains only active and previous. Older receipt-proven Compositions are removed only after their complete payloads are verified and no process lease is live. Live deletion is deferred and converges during a later lifecycle operation. Modified, malformed, symbolic, foreign, or otherwise unproven paths are reported and left untouched. Interrupted cleanup resumes only from an owner-marked, receipt-bound stage.

## Uninstall PorcuPi-owned state

Run the conservative three-page uninstall flow with:

```sh
porcupi uninstall
```

The flow inventories receipt-proven PorcuPi launchers, runtime, activation, Patches, Compositions, leases, and temporary state; separately reports the global and project Pi resource groups that will remain; and requires confirmation. Escape or Ctrl-C cancels without mutation and restores the cursor. Pi settings, package directories, credentials, sessions, project trust/resources, and Stock Pi are never removed or rewritten.

Uninstall fails closed before deletion if an intended PorcuPi target is modified, malformed, foreign, traversing, symbolic, outside its owner root, or disagrees with its receipt. It atomically gates every Composition lease before deletion. A live Pi process defers the operation without termination or payload removal, and a later `porcupi uninstall` retries after it exits.

A confirmed uninstall uses an exact-owner adjacent tombstone and a receipt-bound recovery launcher so interruption after any destructive durability boundary remains retryable. It removes the tombstone last. An already absent installation is a convergent no-op. See [ADR 0009](docs/adr/0009-conservative-receipt-proven-uninstall.md).

## Verify Managed Pi integrity

Every normal Managed Pi launch performs cheap fail-closed checks of PorcuPi ownership and Activation state, matching Composition receipts and identity, platform and owned paths, the committed Patch snapshot, the required executable's exact identity, and the stable launcher's ownership receipt. It does not hash every payload file and is not a complete audit.

Run the complete on-demand check with:

```sh
porcupi verify
```

Verification recomputes the active Composition's normalized complete payload inventory and reruns the required executable identity, exact version, public conformance, and isolated-home smoke checks. It also checks the installed PorcuPi runtime inventory receipt, the stable launcher's exact path, regular-file kind, mode, size, digest, ownership marker, and expected command bytes, plus the optional `pi` alias whenever PorcuPi has an ownership receipt for it. It reports a modified or foreign owned launcher without overwriting it.

Malformed state, receipt disagreement, platform/path mismatch, or a changed required executable makes normal launch exit nonzero. PorcuPi never silently runs the previous Composition or Stock Pi. The error points to `porcupi verify`, retained-composition rollback, `porcupi pi disable` for an unchanged owned alias, and the independently managed Stock Pi path for direct recovery because `pi` may currently resolve to PorcuPi.

These checks provide local-corruption and reproducibility evidence only. They do not establish publisher identity or provenance, and they do not sandbox Pi or Patch-modified code.

The focused [operations guide](docs/operations.md) covers the complete command surface, pending intent, forwarding, lifecycle serialization, leases, and recovery boundaries.

## Development

Run the external-process acceptance suite with one command:

```sh
npm test
```

The tests drive the guided installer and public `porcupi add`, `porcupi manage`, `porcupi apply`, `porcupi rollback`, `porcupi pi enable|disable`, `porcupi uninstall`, launch, and `porcupi verify` commands as external processes through pseudo-terminals and isolated homes/projects, using deterministic local Git Pi Base, mixed resource/Patch Source Repository, metadata, project-trust, integrity-corruption, composition, lifecycle-lock, process-lease, cleanup, interruption, and Pi package-lifecycle fixtures.

The Release Installation gate executes the exact `npm pack` tarball through npm's package-execution path on macOS and Linux with Stock Pi absent and present. It covers collision refusal, fresh install, v0.1.0 upgrade, launch, full verify, rollback, and uninstall, while a separate journey compares the exact-source and packed entrances:

```sh
npm run test:release-installation -- --journey=packed-release --stock-pi=absent
npm run test:release-installation -- --journey=source-parity
```

Durable reports bind exact package and packed integrity, repository revision/tag, Pi Base, fixture, platform, command, outcome, and duration identities. Candidate tests use the local packed artifact and do not publish mutable versions. See the [Release Installation guide](docs/release-installation.md) and [maintainer checklist](docs/releases/release-checklist.md).

The separate networked source-handoff gate composes the exact 20-Patch `pi-wait-for-user` handoff and installs its Question Tool through Pi on macOS and Linux, with and without Stock Pi:

```sh
npm run test:real-handoff -- --stock-pi=absent
```

See [the real handoff acceptance contract](docs/acceptance/real-pi-wait-for-user-handoff.md) for its pinned identities, four-job matrix, complete public-process journey, environment requirements, and durable report format. The v0.1.0 release record is [`release/v0.1.0.json`](release/v0.1.0.json), and its immutable evidence is linked from the [release notes](docs/releases/v0.1.0.md).

The completed minimum-v1 specification and tracer-bullet history are recorded in [PorcuPi v1 issue #12](https://github.com/taylorrowser/PorcuPi/issues/12).
