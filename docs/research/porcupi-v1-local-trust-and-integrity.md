# PorcuPi v1 local trust and integrity

Research and acceptance basis for [PorcuPi issue #8](https://github.com/taylorrowser/PorcuPi/issues/8).

## Primary-source findings

### Pi's trust boundary

- Pi runs with the permissions of the invoking user and treats files writable by that user as part of the same local trust boundary.
- Pi packages have full system access. Extensions execute code, while Skills can instruct the model to run commands or take other actions.
- Project trust decides whether project settings, resources, packages, and Extensions are loaded. It is an input-loading guard, not a sandbox. Declining project trust skips protected project resources; global and CLI Extensions remain available.
- Pi has no built-in sandbox. Package installation, shell commands, language servers, tests, and other tools are ordinary local processes.

Sources: Pi v0.81.1 [Security](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/security.md) and [Packages](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/packages.md).

### Pi's package boundary

- Pi owns Git cloning, package directories, manifest/convention discovery, global/project settings, package filters, npm dependency installation, updates, loading, scope deduplication, and project-trust enforcement.
- Git package refs may be tags or commits. A configured ref is pinned: package updates reconcile the checkout to that ref but do not advance it. A new ref is selected by installing the package with the new ref.
- When reconciliation changes a checkout, Pi resets it to the resolved commit, cleans untracked files, and runs the configured npm install command when `package.json` exists. If `HEAD` already equals the resolved ref, Pi does not clean local changes or reinstall dependencies.
- Pi package identity ignores the Git ref. Within one scope, all selected resources from one normalized repository therefore share one configured checkout/ref. Project configuration wins over global configuration for the same package identity, subject to Pi's documented `autoload: false` delta behavior.
- Package filters narrow resources already allowed by the package manifest/convention rules. They are not separate installations.
- Pi documents no signature, publisher-authentication, per-resource digest, or immutable dependency-tree guarantee for Git packages. npm behavior, including lifecycle behavior, is inherited from Pi's configured npm command and the package being installed.

Sources: Pi v0.81.1 [Packages](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/packages.md) and [`package-manager.ts`](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/src/core/package-manager.ts).

### Retained reference integrity behavior

The pinned `pi-wait-for-user` reference verifies an exact base repository, tag, commit, package identity, and clean tracked state; preflights and applies an ordered Patch series with `git apply --check --whitespace=error-all`; runs `npm ci --ignore-scripts`, model-data hydration, offline build, conformance, and isolated-home smoke checks; stages before publication; atomically selects complete immutable payloads; fails closed on malformed ownership/activation data; verifies payload inventories; and removes only receipt-proven paths.

PorcuPi #7 deliberately retains only the local exact-base/Patch/build, immutable composition, atomic activation, one previous composition, lease-safe cleanup, and Stock Pi preservation portions. PorcuPi #11 explicitly removes the reference implementation's signing, channel, attestation, publication, background update, and broader retention systems.

Sources:

- PorcuPi [#7 resolution](https://github.com/taylorrowser/PorcuPi/issues/7#issuecomment-5106583361)
- PorcuPi [#11 resolution](https://github.com/taylorrowser/PorcuPi/issues/11#issuecomment-5106527557)
- Pinned reference [`pi-patch.mjs`](https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/pi-patch.mjs)
- Pinned reference [`install.mjs`](https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/scripts/install.mjs)
- Pinned reference [managed-installation design](https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/design/managed-installation.md)
- Pinned reference [managed-runtime contract](https://github.com/taylorrowser/pi-wait-for-user/blob/1a987bca79a4f9475dd2037c18b2d6d7b7f68f25/docs/release/managed-runtime.md)

## v1 acceptance contract

### 1. Local trust statement

1. Before PorcuPi records anything from a Source Repository, the user explicitly chooses that repository and sees its canonical locator and resolved exact commit.
2. Selection means trusting the source at the user's authority. It also means trusting package dependencies and fixed build commands that the selected source can influence. PorcuPi does not claim that review, a Git commit, or a SHA-256 creates a sandbox or proves who authored the content.
3. PorcuPi does not bypass, pre-answer, or replace Pi project trust. Project-scoped packages become loadable/installable only under Pi's normal project-trust behavior.
4. Users who need isolation must run Pi/PorcuPi inside an OS, VM, container, or other external sandbox.

### 2. Exact source intent

1. PorcuPi resolves a user-supplied Git ref to a full commit before preview/selection and never retains a moving branch or tag as v1 intent.
2. Non-Patch intent is one Pi Git package source pinned as `@<full-commit>` plus the minimum global/project resource filters. Because Pi package identity ignores refs, all selected resources from one repository in one effective scope use that one commit.
3. Patch intent records the full Artifact identity, canonical repository locator, exact source commit, source-relative regular-file path, and Patch SHA-256.
4. A missing commit, ambiguous source, source/commit mismatch, missing or non-regular Patch, or digest mismatch aborts the current operation before package intent, build publication, or activation changes. PorcuPi never silently advances a commit.
5. Commit and Patch digests bind selected bytes; they do not authenticate a publisher. HTTPS/SSH transport and Git object verification remain Git's behavior.

### 3. Delegation to Pi and npm

For Skills, Extensions, Prompts, and Themes, PorcuPi is only a selection interface over Pi packages:

- Pi owns clone location, checkout/reconciliation, package discovery, filter interpretation, global/project precedence, package installation/removal/update, npm invocation and dependencies, resource loading, and project trust.
- A pinned commit does not advance during `pi update`; changing it is an explicit new selection. Pi may reset/clean a checkout when reconciliation changes its resolved commit.
- PorcuPi does not create a second resource copy, per-Artifact receipt, dependency lock, update planner, runtime audit, or launch-time package verifier.
- PorcuPi does not claim that Pi/npm verifies a publisher, suppresses package scripts, preserves a pristine checkout when `HEAD` already matches, or gives dependencies stronger integrity than Pi/npm actually provide.
- Package install/update failures remain Pi package failures. They do not rebuild, roll back, or change the active Managed Pi Composition.

### 4. Patch build integrity

A build must, in order:

1. create PorcuPi-owned temporary state from the PorcuPi release's exact Pi Base and verify repository, tag, commit, expected package identity/version, and clean tracked state;
2. verify every selected Patch's exact source commit, regular-file path, and SHA-256;
3. preflight the complete deterministic series in an isolated checkout with `git apply --check --whitespace=error-all`, then apply that same series to the build checkout;
4. run only the PorcuPi-release-fixed locked install with lifecycle scripts disabled, model-data hydration, offline build, public conformance, and isolated-home version/smoke sequence inherited from #7;
5. create an embedded composition receipt containing the exact Pi Base, ordered Patch identities/commits/digests, PorcuPi/build-recipe version, platform/architecture, required executable identity, and a normalized payload inventory with file kind, mode, size, and SHA-256; and
6. publish the complete staged payload immutably by same-filesystem rename, then atomically select it through the activation record.

Patches cannot add build steps or bypass checks. The fixed commands still execute with the user's authority, and a Patch may alter source those commands consume. Any failure removes only receipt-proven temporary state and leaves the current composition selected.

### 5. Local verification and fail-closed behavior

- **Malformed control state:** Strict readers reject unsupported schemas, missing/unknown required data, invalid IDs, path traversal, symlink substitution, paths outside PorcuPi's root, platform mismatch, and activation/receipt identity mismatch. Normal launch exits nonzero with verify/rollback/Stock Pi guidance and never silently launches the previous composition or Stock Pi.
- **Source mismatch:** During a PorcuPi selection/build operation, a repository commit or Patch digest mismatch aborts without changing intent or activation. Outside such an operation, non-Patch checkout/dependency state belongs to Pi and is not independently audited by PorcuPi.
- **Candidate payload mismatch:** Activation and rollback perform complete receipt and payload-inventory verification before switching. A mismatch leaves the current composition active.
- **Active payload mismatch:** Normal launch performs the cheap #7 checks: activation schema/identity, receipt binding, platform/path sanity, and required executable identity before taking a process lease. Any mismatch those checks detect refuses launch. `porcupi verify` recomputes the complete payload inventory and runs required executable identity/smoke checks; any modification fails verification. Normal launch is not described as a full-file audit.
- **Ownership mismatch:** Publication, cleanup, rollback, disable, and uninstall mutate only paths whose central and embedded ownership evidence agree. Modified, foreign, malformed, traversing, or symlink-substituted state is left untouched and the operation fails nonzero. Live-leased payload deletion is deferred.
- **Launcher mismatch:** Installation and optional `pi` ownership refuse every foreign file/symlink collision—there is no overwrite, backup, rename, or force option. PorcuPi records owned launcher path, kind, size, and SHA-256. Verify, disable, and uninstall refuse to mutate a launcher that no longer matches. An already executing launcher cannot authenticate itself against a same-user attacker; it is inside Pi's documented local trust boundary.
- **Stock Pi:** PorcuPi never receipt-owns or mutates Stock Pi. Pi settings, package directories, credentials, sessions, trust data, and project resources are also outside Managed Pi Composition ownership.

### 6. Explicit non-claims

PorcuPi v1 has no signing keys, release channels, publisher manifests, attestations, registry, publisher authentication, provenance service, sandbox, background trust refresh, background package audit, or automatic trust revocation. Exact commits, SHA-256 values, receipts, and fail-closed local checks provide reproducibility and local corruption/ownership detection only.
