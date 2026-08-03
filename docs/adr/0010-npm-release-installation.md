# ADR 0010: Deliver Release Installation as a packed npm artifact

## Status

Accepted for the Release Installation entrance in issue #41.

## Context

The exact-tag source entrance is auditable, but it requires users to clone PorcuPi before starting the guided installer. Node.js and npm are already prerequisites. An easier entrance must not introduce a mutable PorcuPi download after launch, make npm the owner of installed state, or create a second release authority.

PorcuPi v0.1.0 predates this decision. Its accepted source release and evidence remain immutable; v0.1.0 is not retroactively published as the official npm artifact.

## Decision

Each npm-enabled PorcuPi release has one official public npm artifact named `porcupi`. Users identify an exact version. The package version, matching Git tag release record, Pi Base lock, fixed recipe, and package lock must agree before packing.

The package exposes one executable named `porcupi`. npm fetches, unpacks, and starts that one-shot installer. The package has no install lifecycle hook and npm does not own the installed launcher, runtime, state, Managed Pi Compositions, optional `pi` alias, or uninstall lifecycle. The installer copies its receipt-inventoried runtime into the PorcuPi ownership root, so the npm cache is not required after installation.

The packed inventory is an explicit regular-file allowlist. It includes the local installer entry, complete PorcuPi runtime, exact Pi Base lock, pinned model-data snapshot, and matching release record. Packing fails when a declared input is missing, when a release-fixed input is undeclared, or when package, release, lock, and recipe identities disagree. Test and orchestration code is excluded. The installer imports only implementation bytes in that artifact; it does not fetch PorcuPi code from a branch or mutable channel after execution begins. Network access remains necessary for the release-fixed Pi Base and its locked dependency installation.

GitHub remains the canonical source and release record. Registry metadata and packed integrity are evidence bound to that record, not an independent release authority. The exact-tag source entrance remains the advanced audit and fallback path. Both entrances invoke the same guided Release Installation module and must produce identical receipt-bound Managed Pi state for identical release and platform inputs.

Pre-release acceptance executes the exact packed output through npm's package-execution path in an external pseudo-terminal. It covers cancellation, collisions, command ownership, Stock Pi preservation, launch, full verification, and conservative uninstall. Release publication and the public registry gate remain separate maintainer actions.

## Consequences

- The primary Release Installation can become `npx --yes porcupi@<exact-version>` without introducing a mutable release channel.
- Removing npm's cache or temporary package after a successful installation does not affect Managed Pi.
- Adding, removing, or renaming a runtime or release input requires an intentional packed-inventory change.
- npm publication must follow the matching GitHub release and acceptance evidence; npm cannot define a PorcuPi release by itself.
- The source and npm entrances share all lifecycle, ownership, integrity, and uninstall behavior rather than maintaining separate installers.
