# Reference manager and Pi installation contracts

Research for [PorcuPi issue #3](https://github.com/taylorrowser/PorcuPi/issues/3).

## Answer

PorcuPi should preserve the reference manager's **safety properties and state-machine shape**, not its downstream-release publication system. In particular, PorcuPi needs explicit command ownership, exact path ownership, immutable staged content, one atomic activation decision, fail-closed launch, verified rollback, serialized mutation, process leases, receipt-bounded cleanup, and idempotent recovery. The reference's root/delegated signing hierarchy, signed Release Channel and Release Manifest, GitHub publication workflow, Question Tool/session compatibility tuple, Patch Lag policy, and Windows implementation are inputs to later PorcuPi decisions, not inherited v1 requirements.

For Pi 0.81.1, the native auto-discovery destinations are:

| Artifact | User-global | Project-local | Auto-discovered shape |
| --- | --- | --- | --- |
| Skill | `~/.pi/agent/skills/` or `~/.agents/skills/` | `.pi/skills/`, plus `.agents/skills/` in `cwd` and ancestors | A directory containing `SKILL.md` is one Skill. `SKILL.md` directories are found recursively. Direct root `.md` files are also Skills in the `.pi` locations, but are ignored in `.agents/skills`. |
| Extension | `~/.pi/agent/extensions/` | `.pi/extensions/` | Direct `.ts`/`.js` files and one-level child directories with `index.ts`/`index.js`. |
| Prompt | `~/.pi/agent/prompts/*.md` | `.pi/prompts/*.md` | Direct `.md` files only; automatic discovery is non-recursive. |

Project-local resources are inactive until Pi trusts the project. The `.pi` directories are rooted at the invocation's `cwd`; only project `.agents/skills` has ancestor discovery. Pi also accepts resources through package manifests, settings paths, and additive CLI flags, but those are additional loading mechanisms rather than extra native installation scopes. [Pi Skills, Locations][pi-skills-locations] [Pi Extensions, Extension Locations][pi-extension-locations] [Pi Prompt Templates, Locations and Loading Rules][pi-prompt-locations]

## Sources and version boundary

I inspected the requested immutable reference checkout, [`pi-wait-for-user@1a987bca79a4f9475dd2037c18b2d6d7b7f68f25`][reference-commit], rather than a local working checkout. The principal reference sources were its accepted Managed Installation design, runtime requirements, dispatcher, manager entrypoint, and manager runtime implementation. [Managed Installation design][reference-design] [Runtime requirements][reference-runtime] [Managed Dispatcher source][reference-dispatcher] [Manager source][reference-manager] [Manager runtime source][reference-manager-runtime]

For Pi, I read the installed official `@earendil-works/pi-coding-agent` package at version **0.81.1** under the path specified by the ticket. I read the relevant Markdown files completely, including their settings and package cross-references, then checked the installed compiled source for discovery, precedence, collision, and trust behavior. The installed docs are byte-identical to the official source at immutable commit [`20be4b18d4c57487f8993d2762bace129f0cf7c6`][pi-commit], the commit tagged `v0.81.1`; citations below use that immutable public source.

The findings are therefore an inventory of **Pi 0.81.1**, not a claim that unversioned future Pi releases will keep every source-level detail.

## What remains relevant from the reference manager

### 1. Keep these as PorcuPi requirements

#### Explicit, non-destructive command ownership

- `porcupi` can be installed side by side without claiming `pi`; making `pi` resolve to Managed Pi must remain a separate explicit opt-in.
- PorcuPi must shadow Stock Pi from a PorcuPi-owned bin directory, never patch, replace, rename, back up, or delete the Stock Pi launcher's path.
- A pre-existing unowned launcher is a hard collision. A losing `PATH` order is an incomplete enablement, not success; remediation is reported rather than shell startup files being edited.
- Disablement removes only PorcuPi's owned `pi` entrypoint. Uninstall removes only receipt-proven PorcuPi state and reports which Stock Pi, if any, resolves afterward.

These are explicit reference invariants, and the implementation publishes its compatibility entrypoint before `pi`, records Stock Pi identity, and checks final command resolution. [Reference invariants][reference-invariants] [Reference ownership behavior][reference-ownership] [Reference enable implementation][reference-enable]

**PorcuPi adaptation:** the reference treats all `~/.pi/agent` data as shared and outside manager ownership. PorcuPi's purpose requires it to manage selected Artifact paths in Pi discovery trees, but it must not broaden that into ownership of the containing settings tree. Every managed file or directory needs exact ownership evidence; neighboring user files and Stock Pi itself remain foreign.

#### Immutable staged content and one atomic activation decision

- Resolve the complete candidate composition before activation.
- Stage into uniquely owned temporary paths; reject traversal, symlink substitution, unsupported file kinds, and inventory/digest mismatches.
- Publish verified content under immutable identities.
- Select the complete new composition with one durable atomic state replacement only after all required content has been published and verified.
- Before that switch, the old composition remains active; after it, the new complete composition is active and cleanup is retryable. Cleanup never runs before the switch.

The reference implements state writes as create-exclusive temporary files followed by `fsync`, rename, and best-effort directory `fsync`; it publishes immutable trees and rejects identity reuse with changed content. [Atomic state write][reference-atomic-write] [Staging and archive checks][reference-staging] [Immutable publication and receipts][reference-publish] [Activation transaction][reference-activation]

**PorcuPi adaptation:** the atomic unit becomes the confirmed Artifact/dependency closure plus the compatible Managed Pi composition, rather than the reference's fixed `{Manager Release, Downstream Release}` pair. The mechanism does not require PorcuPi to copy the reference's metadata schema.

#### Strict receipts and bounded cleanup

- Persist enough state to prove the exact path, kind, content identity, selected composition, and creation provenance of every PorcuPi-owned projection.
- Validate paths against traversal and symlink substitution before mutation.
- Treat missing, malformed, contradictory, or foreign ownership evidence as a stop condition; never “repair” it by deleting or overwriting uncertain content.
- Use receipt-scoped temporary and tombstone paths so interrupted cleanup can converge without touching foreign files.

The reference uses matching embedded and central receipts, verifies exact payload inventories, and performs full uninstall preflight before removing either command path. [Receipt validation][reference-receipts] [Filesystem ownership contract][reference-filesystem-ownership] [Uninstall contract][reference-uninstall-contract] [Uninstall implementation][reference-uninstall]

**PorcuPi adaptation:** an installed Artifact may project into a shared Pi discovery directory, so the ownership record must be per Artifact projection, not a receipt for the whole `skills/`, `extensions/`, `prompts/`, `.pi`, or `~/.pi/agent` directory.

#### Fail-closed launch with explicit recovery

- A corrupt or unverifiable selected Managed Pi must not silently run Stock Pi or silently select an older composition.
- Keep a small stable launcher/recovery boundary independent of the selected versioned payload.
- Make previous-composition recovery explicit, local, and fully re-verified; failed recovery leaves the current selection unchanged.
- Keep disablement available as the explicit route back to normal Stock Pi resolution.

The dispatcher itself owns only selection, lease acquisition, fail-closed diagnostics, previous recovery, and disablement. [Dispatcher contract][reference-entrypoints] [Dispatcher implementation][reference-dispatcher] [Rollback and recovery][reference-rollback-recovery]

#### Serialized mutation, live-process leases, and post-switch retention

- Serialize mutating lifecycle operations with an ownership-bearing lock and safe stale-owner recovery.
- Allow normal launches without taking the lifecycle lock.
- Lease the selected immutable composition for the child process lifetime so updates may activate a new composition while old processes finish.
- Retain at least the active and immediately previous verified compositions; defer pruning/uninstall of live-leased content and retry later.

The reference implements process-identity-aware lifecycle locks, preparing/active pair leases, cleanup claims that close the lease race, and deferred deletion. [Reference retention and concurrency][reference-retention] [Lifecycle lock implementation][reference-lock] [Lease and dispatch implementation][reference-lease]

#### Idempotent lifecycle and stage-specific failure behavior

Install, enable, disable, verification, update, rollback, prune, and uninstall should have convergent repeated behavior. A candidate failure deletes only proven staging content, leaves the prior selection active, records bounded non-executable diagnostics, and exits nonzero with the failing stage. A failure after the activation switch may defer cleanup but must not pretend the complete activation rolled back. [Reference lifecycle idempotency][reference-idempotency] [Runtime failure boundaries][reference-runtime-activation]

### 2. Keep these mechanisms as design patterns, not mandatory representations

| Reference mechanism | PorcuPi use |
| --- | --- |
| Stable dispatcher plus versioned manager/runtime payloads | Preserve the stable-launcher seam and independently replaceable lifecycle implementation. The exact two-release pairing can change to a PorcuPi composition record. |
| `activation.json` with active and previous pairs | Preserve one atomic active-composition record and a directly recoverable previous record; settle exact schema in the activation/persistence tickets. |
| Embedded and central receipts | Preserve independently checkable ownership and content evidence. Whether v1 needs two byte-identical copies is a design choice, provided cleanup never relies on an uncorroborated path claim. |
| Full artifact cache plus immutable extracted trees | Preserve content-addressed immutable storage and verify projections against it; fit the cache to Git-backed Artifact Revisions and Managed Pi builds. |
| Exact update-command classifier | Preserve fail-closed routing when `pi` could otherwise self-update outside PorcuPi. The accepted PorcuPi CLI may use different commands. |
| Local previous-only rollback and explicit pins | Preserve offline verified rollback, retention, and explicit pinning; define retention counts and user interface later. |
| Smoke/conformance checks before activation | Preserve verification at public executable/behavior seams, adapted to Stock Pi version, patch application, and selected extension/skill/prompt discovery. |

### 3. Do not automatically inherit these reference requirements

- **Delegated signing and publication:** the pinned root key, root-signed expiring delegated keys, signed mutable Release Channel, complete signed Release Manifest, monotonic replay state, cross-signed root rotation, protected GitHub release environment, and mandatory promotion-time attestations are one high-assurance publication design. The map expressly leaves PorcuPi's smaller v1 trust model to issue #8. [Reference release authority][reference-release-authority]
- **Downstream-specific compatibility:** exact Question Tool package/handler/protocol fields, durable-deferral session identities, downstream conformance, and Stock Pi's inability to open downstream sessions belong to the pi-wait-for-user handoff, not every PorcuPi Artifact. [Reference session compatibility][reference-session-compatibility]
- **Patch Lag and passive update UX:** the 24-hour detached check, downstream channel sequence, upstream informational endpoint, Update Hold, and special `pi update --all` split are specific policies. PorcuPi already requires explicit Artifact updates; later tickets should adopt only the routing and atomicity properties they need. [Reference update behavior][reference-update-behavior]
- **Legacy downstream adoption:** byte-for-byte adoption of old pi-wait-for-user layouts is useful migration evidence, not a generic v1 install path unless issue #10 requires it. [Reference legacy adoption][reference-legacy-adoption]
- **Windows mechanisms:** `.cmd` collision variants, PowerShell bootstrap behavior, native process identity, and executable-lock cleanup are out of PorcuPi v1 scope. [Reference platform plan][reference-platform-plan]
- **Reference release identities:** PorcuPi's content-addressed Artifact Revision and composed Managed Pi identity should not be replaced with the reference's release ID or source commit identity. [Reference Activation identity][reference-runtime-activation]

## Pi 0.81.1 discovery contracts

### Project trust is part of project-local activation

Pi treats `.pi/settings.json`, `.pi` resources, missing project packages, executable project extensions, and project `.agents/skills` as trust-gated. Interactive mode prompts when relevant resources exist and no decision applies. Non-interactive modes do not prompt: with the default `defaultProjectTrust: "ask"`, project resources are ignored; `always`, `never`, or the one-run `--approve`/`--no-approve` flags change that result. `/trust` persists a decision in `~/.pi/agent/trust.json` and requires a restart for the current session to reload it. [Pi Settings, Project Trust][pi-project-trust]

The source performs a pre-trust load with project settings disabled so only user/global and temporary CLI extensions can participate in the trust decision. It detects `.agents/skills` in ancestors as trust-requiring while treating user-global `~/.agents/skills` as trusted user content. [Resource loader trust bootstrap][pi-resource-trust] [Trust-resource detection][pi-trust-detection]

**Consequence:** PorcuPi can install a project-local Artifact successfully while Pi still refuses to load it. Installation/status output and acceptance tests must distinguish “projected into Pi's discovery location” from “active in this Pi invocation because the project is trusted.” PorcuPi must not silently grant Pi trust.

### Skills

Pi's documented locations and behavior are:

- user-global `~/.pi/agent/skills/` and `~/.agents/skills/`;
- project `.pi/skills/`, plus `.agents/skills/` in `cwd` and each ancestor up to the Git repository root (or filesystem root outside a repository), only after trust;
- packages via conventional `skills/` or `pi.skills` manifest entries;
- `skills` settings paths; and repeatable `--skill <path>` CLI paths;
- recursive discovery of directories containing `SKILL.md`; direct root `.md` discovery only in the `.pi` locations;
- `--no-skills` disables normal discovery, but explicit CLI `--skill` paths remain additive. [Pi Skills, Locations][pi-skills-locations]

A Skill's directory is semantically significant: the agent resolves referenced scripts, assets, and documents relative to that directory. Pi scans names/descriptions at startup, then reads the full `SKILL.md` on demand. [Pi Skills, How Skills Work and Structure][pi-skill-structure]

**Installation consequence:** a directory Skill must be projected as a whole directory with `SKILL.md` at its root; copying only `SKILL.md` breaks its contract. A root-file Skill is portable to `.pi/skills` but not to `.agents/skills`. PorcuPi should detect the effective Skill name from frontmatter before projection because Pi diagnoses same-name collisions and keeps the first loaded Skill. [Skill collision implementation][pi-skill-collision]

### Extensions

Pi auto-discovers trusted extensions from:

- user-global `~/.pi/agent/extensions/*.ts` and `*/index.ts`;
- project `.pi/extensions/*.ts` and `*/index.ts`;
- package `extensions/` directories or `pi.extensions` manifest entries;
- `extensions` settings paths; and repeatable `--extension`/`-e` CLI paths. JavaScript counterparts are also accepted by the implementation. [Pi Extension Locations][pi-extension-locations] [Extension discovery implementation][pi-extension-discovery]

Extensions execute arbitrary code with the user's full permissions. TypeScript is loaded through `jiti`; adjacent or ancestor `package.json` dependencies may be resolved from `node_modules`. Distributed npm/git Pi packages receive production dependency installs, so runtime dependencies must be in `dependencies`, not only `devDependencies`. [Pi Extensions, imports and dependencies][pi-extension-dependencies]

**Installation consequence:** a single-file Extension can be a direct `.ts`/`.js` projection. A multi-file Extension needs a child directory whose entrypoint is `index.ts`/`index.js`, or an explicitly loaded/package-manifest entry. Preserve supporting modules and runtime dependencies. Treat install/upgrade as executable-code activation, with pre-install review/trust messaging and collision checks.

### Prompt templates

Pi loads prompts from:

- user-global `~/.pi/agent/prompts/*.md`;
- trusted project `.pi/prompts/*.md`;
- package `prompts/` directories or `pi.prompts` manifest entries;
- `prompts` settings paths; and repeatable `--prompt-template <path>` CLI paths.

Native `prompts/` auto-discovery is non-recursive. The filename is the slash-command name (`review.md` becomes `/review`); frontmatter `description` and `argument-hint` are optional, and prompt bodies support Pi's documented argument substitution. [Pi Prompt Templates][pi-prompt-locations]

**Installation consequence:** native prompt projection must put the `.md` file directly in the selected scope's `prompts/` directory. A nested Source Repository path cannot be reproduced beneath that directory and still auto-discover without an explicit settings or package entry. Therefore the projection filename is user-visible command identity and must be collision-checked.

### Packages and settings are loading mechanisms, not new scopes

A Pi package may declare `extensions`, `skills`, and `prompts` under the `pi` key in `package.json`; without a manifest, Pi applies conventional `extensions/`, `skills/`, and `prompts/` discovery. `pi install` writes global settings by default and project settings with `-l`; project package installation and loading remain trust-gated. [Pi Packages, install and scope][pi-package-install] [Pi Packages, structure][pi-package-structure]

Resource paths in global settings resolve relative to `~/.pi/agent`; paths in project settings resolve relative to `.pi`. Settings arrays accept glob/exclusion filters. Project settings override global settings, and a duplicate package identity in both scopes normally resolves to the project package entry. [Pi Settings, Resources][pi-settings-resources] [Pi Packages, Scope and Deduplication][pi-package-dedupe]

**PorcuPi consequence:** package/settings registration may be useful when an Artifact cannot fit native auto-discovery, but mutating a shared settings file creates a co-ownership and merge problem. Direct native projections minimize that problem but cannot express every nested prompt or unconventional extension entry. Issue #5 should make that tradeoff explicit and receipt whichever projection or settings edit it chooses.

### Collision and precedence behavior at the inspected version

The public docs say Skill name collisions warn and keep the first Skill, but they do not fully promise a cross-source collision order for all resource kinds. The 0.81.1 source sorts resources so first-wins resolution sees this precedence:

1. project settings entries;
2. project auto-discovered resources;
3. user settings entries;
4. user auto-discovered resources;
5. package resources.

It canonical-path-deduplicates after sorting. Skills and prompts diagnose same-name collisions and retain the first; extension conflicts are diagnosed while all extensions remain loaded, with operational precedence handled by load order. [Resource precedence source][pi-resource-precedence] [Resource sorting source][pi-resource-sorting] [Prompt collision source][pi-prompt-collision]

This is useful for collision detection and tests, but PorcuPi should **not** use it as an overwrite strategy. It should preflight both managed records and the actual target paths/names, refuse unowned collisions by default, and report any already-present competing Pi resource. That avoids depending on undocumented ordering details that may change after 0.81.1.

## Required downstream decisions now made specifiable

This research does not require a new child ticket: the map already has the needed create-then-wire coverage.

- [#2 Artifact model](https://github.com/taylorrowser/PorcuPi/issues/2): define each kind's content boundary using the Skill directory, Extension entrypoint/support tree, Prompt file, and patch boundary.
- [#5 installation scope and ownership](https://github.com/taylorrowser/PorcuPi/issues/5): choose native projection versus settings/package registration; define exact receipts, collision behavior, trust-state reporting, shared-tree preservation, command ownership, and uninstall.
- [#7 patch composition and Managed Pi activation](https://github.com/taylorrowser/PorcuPi/issues/7): adopt staged immutable composition, one atomic active record, previous composition, leases, rollback, and fail-closed launch.
- [#8 trust and verification](https://github.com/taylorrowser/PorcuPi/issues/8): choose the smallest Git/content trust model without assuming delegated release signing.
- [#9 command interface](https://github.com/taylorrowser/PorcuPi/issues/9): expose explicit `pi` ownership, trust-gated project activation status, recovery, verify, and rollback.
- [#10 migration handoff](https://github.com/taylorrowser/PorcuPi/issues/10): separate pi-wait-for-user's Question Tool/session/patch declarations from manager responsibilities and define any legacy adoption.

## Factual limits to carry forward

1. Pi's official docs do not state a long-term compatibility guarantee for these layouts or collision precedence. The specification should name its supported Pi contract/version and test discovery behavior when updating Managed Pi.
2. Pi provides discovery and project trust, but it does not provide PorcuPi with transactional multi-Artifact installation, ownership receipts, local-edit detection, or rollback. Those remain PorcuPi responsibilities.
3. User-global means global to Pi's default agent directory, not inherently “Managed Pi only.” Any Stock Pi using the same `~/.pi/agent` and project directory can discover the same projected skills, extensions, and prompts. If later decisions require Managed-Pi-only non-patch Artifacts, they must select an isolated agent directory or inject explicit resource paths instead of using the default global/project locations.

[reference-commit]: https://github.com/taylorrowser/pi-wait-for-user/tree/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25
[reference-design]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/design/managed-installation.md
[reference-runtime]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/release/managed-runtime.md
[reference-dispatcher]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/managed-dispatcher.mjs#L13-L51
[reference-manager]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/managed-manager.mjs#L155-L182
[reference-manager-runtime]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs
[reference-invariants]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/design/managed-installation.md#L35-L49
[reference-ownership]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/release/managed-runtime.md#L97-L103
[reference-enable]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs#L2700-L2792
[reference-atomic-write]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs#L167-L183
[reference-staging]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs#L563-L641
[reference-publish]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs#L854-L931
[reference-activation]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs#L1216-L1397
[reference-receipts]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs#L870-L931
[reference-filesystem-ownership]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/design/managed-installation.md#L346-L356
[reference-uninstall-contract]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/release/managed-runtime.md#L105-L109
[reference-uninstall]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs#L3156-L3260
[reference-entrypoints]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/release/managed-runtime.md#L5-L17
[reference-rollback-recovery]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/release/managed-runtime.md#L89-L95
[reference-retention]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/design/managed-installation.md#L264-L279
[reference-lock]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs#L391-L543
[reference-lease]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/lib/managed-runtime.mjs#L1815-L1993
[reference-idempotency]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/design/managed-installation.md#L358-L366
[reference-runtime-activation]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/release/managed-runtime.md#L52-L68
[reference-release-authority]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/design/managed-installation.md#L103-L143
[reference-session-compatibility]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/design/managed-installation.md#L327-L344
[reference-update-behavior]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/release/managed-runtime.md#L70-L85
[reference-legacy-adoption]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/release/managed-runtime.md#L87-L87
[reference-platform-plan]: https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/design/managed-installation.md#L368-L372

[pi-commit]: https://github.com/earendil-works/pi/tree/20be4b18d4c57487f8993d2762bace129f0cf7c6
[pi-skills-locations]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/skills.md#L20-L42
[pi-skill-structure]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/skills.md#L64-L133
[pi-extension-locations]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/extensions.md#L109-L139
[pi-extension-dependencies]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/extensions.md#L141-L170
[pi-prompt-locations]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/prompt-templates.md#L7-L95
[pi-project-trust]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/settings.md#L12-L24
[pi-package-install]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/packages.md#L18-L46
[pi-package-structure]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/packages.md#L116-L166
[pi-package-dedupe]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/packages.md#L222-L229
[pi-settings-resources]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/docs/settings.md#L230-L269
[pi-resource-trust]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/resource-loader.ts#L330-L345
[pi-trust-detection]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/trust-manager.ts#L179-L205
[pi-skill-collision]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/skills.ts#L386-L433
[pi-extension-discovery]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/extensions/loader.ts#L604-L718
[pi-resource-precedence]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/package-manager.ts#L173-L191
[pi-resource-sorting]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/package-manager.ts#L2527-L2552
[pi-prompt-collision]: https://github.com/earendil-works/pi/blob/20be4b18d4c57487f8993d2762bace129f0cf7c6/packages/coding-agent/src/core/resource-loader.ts#L914-L936
