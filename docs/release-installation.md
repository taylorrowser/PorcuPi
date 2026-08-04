# Install or upgrade with Release Installation

PorcuPi v0.2.0 supports **Release Installation** on macOS and Linux. Run the official npm artifact at one exact version:

```sh
npx --yes porcupi@0.2.0
```

The exact version is intentional: it prevents the command from silently resolving to a later PorcuPi release. There is no mutable release channel and no automatic update. npm downloads and starts this one-shot installer, but npm does not own the resulting launcher, runtime, state, Managed Pi Compositions, optional `pi` alias, or uninstall lifecycle. GitHub remains the canonical source and release record.

## Requirements and boundaries

Release Installation is:

- **networked**: npm must acquire the exact PorcuPi artifact, and the installer acquires release-fixed Pi inputs and locked dependencies;
- **interactive**: it requires a terminal and explicit guided review; unattended flags are not supported;
- supported only on **macOS and Linux**; and
- dependent on **Git, npm, and supported Node.js** (Node.js 22.19 or newer for v0.2.0).

Confirm the tools before starting:

```sh
git --version
npm --version
node --version
```

PorcuPi does not edit shell configuration. Add `~/.local/bin` to `PATH` yourself if the installer reports that it is missing.

### Legacy `pi-wait-for-user` is a prerequisite boundary

If `pi-wait-for-user` created a Managed Installation on this machine, stop before running Release Installation. Complete the old-manager disable, uninstall, preservation, and verification steps in the [manual migration procedure](migration-from-pi-wait-for-user.md), then return to this v0.2.0 guide rather than following that historical document's v0.1.0 install link. PorcuPi refuses legacy manager state and does not adopt its state or payloads.

This differs from upgrading **PorcuPi v0.1.0**, which the same exact v0.2.0 command supports directly. The historical v0.1.0 source instructions, release record, and acceptance artifacts remain immutable; v0.1.0 was not retroactively published to npm.

## Fresh installation

Run:

```sh
npx --yes porcupi@0.2.0
```

The three guided pages identify the exact PorcuPi release and Pi Base, ask whether PorcuPi should own the `pi` command, and review the operation. `pi` ownership defaults to **No**. The installer refuses a foreign file, symbolic link, directory, or other collision at `~/.local/bin/porcupi` and at the optional `~/.local/bin/pi` path. It never overwrites, adopts, moves, or backs up an unknown entry.

With the default choice, Release Installation creates `porcupi` without creating `pi`. An independently installed Stock Pi remains byte-for-byte unchanged. Choosing `pi` ownership is explicit and reversible; it does not modify or use Stock Pi as a fallback.

After installation:

```sh
porcupi --version
porcupi verify
```

`porcupi verify` performs the complete receipt, payload, runtime, launcher, conformance, version, and isolated smoke checks. Ordinary launch uses the cheaper fail-closed checks described in [ADR 0006](adr/0006-cheap-launch-and-explicit-full-verification.md).

## Upgrade an intact v0.1.0 installation

Use the same exact target command:

```sh
npx --yes porcupi@0.2.0
```

Release Installation recognizes receipt-verified v0.1.0 state and presents the explicit three-page upgrade journey. Before final confirmation, its non-mutating Upgrade Readiness Check stages the retained Selection Intent against v0.2.0's exact Pi Base and fixed recipe. The review identifies installed and target PorcuPi releases and Pi Bases, active and selected Patches, selected Pi resources and Installation Scope, pending intent, and current optional `pi` ownership.

Cancellation or readiness failure leaves the installed runtime, launchers, active/previous Compositions, Selection Intent, Pi settings and resources, and Stock Pi unchanged. A successful upgrade preserves Selection Intent and current `pi` ownership, activates the verified target Composition, and retains the former active Composition for `porcupi rollback`. Rollback changes only Managed Pi Composition activation; it does not downgrade the PorcuPi manager runtime. Arbitrary PorcuPi downgrade remains unsupported.

After an interruption, rerun the same exact command. Receipt-bound recovery completes only the committed old-or-new transaction. Lifecycle locks and process leases prevent mutation from racing another operation or deleting a Composition used by a running Managed Pi.

## Advanced audit and fallback: exact-tag source entrance

The exact-tag source path remains the advanced audit and fallback entrance. It invokes the same guided Release Installation implementation as the npm artifact:

```sh
git clone --branch v0.2.0 --depth 1 https://github.com/taylorrowser/PorcuPi.git
cd PorcuPi
git rev-parse HEAD
./install.sh
```

Compare the resolved commit with the `v0.2.0` GitHub release before executing the source. The source entrance is not the primary journey because it requires cloning and entering a checkout, but it remains independently gated for parity and allows inspection before launch.

Neither entrance authenticates a publisher or provides a sandbox. Exact Git identities, packed integrity, Patch digests, receipts, and inventories provide reproducibility and local-corruption evidence. PorcuPi, Pi, selected Patches, packages, dependencies, and build commands execute with the user's authority; use an OS account, VM, container, or another external isolation boundary when needed.

## Rollback and uninstall

Use the public lifecycle commands for locally retained Composition rollback and conservative removal:

```sh
porcupi rollback
porcupi uninstall
```

Uninstall removes only receipt-proven PorcuPi-owned runtime, launchers, state, and Compositions. It preserves Stock Pi and Pi-owned settings, packages, credentials, sessions, project trust, and project resources. See the [operations guide](operations.md) for the complete command and recovery contract.

## Release evidence

The [`v0.2.0` release record](../release/v0.2.0.json) binds package and source identities, Pi Base, fixed recipe, supported platforms, and the durable acceptance-report contract. The Release Installation gate executes the exact packed artifact through npm's package-execution process on macOS and Linux with Stock Pi absent and present. It covers collision refusal, fresh install, v0.1.0 upgrade, launch, full verification, rollback, and uninstall. A separate macOS/Linux journey compares exact-source and packed installed state.

Each uploaded acceptance artifact retains the exact tested `package/<filename>` tarball beside JSON and Markdown reports recording its npm package name/version, relative path, and packed integrity, plus the repository revision and tag, Pi Base, historical and Stock Pi fixtures, platform, every public command, outcome, and duration. Candidate tests use that local tarball produced by `npm pack`; they do not publish mutable test versions or rebuild after acceptance. Maintainers complete the [release checklist](releases/release-checklist.md) before publication.
