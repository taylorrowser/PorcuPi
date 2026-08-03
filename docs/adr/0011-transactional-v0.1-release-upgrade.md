# ADR 0011: v0.1.0 zero-Patch Release Installation upgrade

## Status

Accepted for the first cross-release upgrade in issue #42.

## Context

PorcuPi v0.1.0 treats an owned active installation as a same-release recovery target. The first npm-enabled release must instead recognize an intact historical installation, assess a replacement without disturbing it, and switch the installed PorcuPi runtime and Managed Pi Composition without conflating Composition rollback with a manager downgrade.

The historical release has version-1 root ownership, Activation, Selection Intent, runtime and launcher receipts, and Composition receipts. Its receipt-inventoried runtime contains its exact `package.json`, so the installed PorcuPi release can be established without inferring it from a launcher or active Composition.

## Decision

Every npm-enabled, version-aware Release Installation target compares its exact invoking package version with the receipt-verified installed runtime version before showing an installation prompt:

- a matching version performs convergent verification without rebuilding or re-asking command ownership;
- a newer version enters the explicit upgrade journey; and
- an older version is refused as an unsupported PorcuPi downgrade.

The first migration contract is keyed by both endpoints: `PorcuPi 0.1.0 / state schema 1` to `PorcuPi 0.2.0 / state schema 1`. It applies only to an intact zero-Patch installation with empty Selection Intent. Selected Artifact migration belongs to issue #43, and publication-boundary interruption, corruption, and lease hardening belong to issue #44. A different source version, target version, or schema requires another explicit migration contract; a numerically newer installer alone is insufficient.

Before final confirmation, Release Installation runs a non-mutating Upgrade Readiness Check from the invoking release's fixed inputs. It builds the exact zero-Patch target through the target dependency, model-data, build, conformance, version, and smoke pipeline. The candidate Composition and runtime remain in an owner-marked temporary stage. Cancellation or readiness failure removes that stage and leaves the installed runtime, launchers, Activation, published Compositions, empty Selection Intent, and shared Pi/Stock Pi state unchanged.

After confirmation, PorcuPi publishes the verified target Composition, replaces the receipt-inventoried runtime at the stable path, verifies the unchanged stable and optional launchers against that runtime, and atomically replaces Activation. The new active entry names the target zero-Patch Composition and `previous` names the former active Composition. The target runtime reads the retained state schema, so the runtime-first switch does not expose an unreadable state shape. A caught error before Activation restores the prior runtime and receipt. The existing Composition cleanup keeps the active and one previous Composition under ADR 0007.

The target writes runtime-receipt schema 2 and accepts both historical schema 1 and target schema 2. Schema 2 is a compatibility fence against the immutable v0.1.0 source installer: that historical code predates version-aware Release Installation, prompts before inspecting an existing installation, and can report only its fixed `Malformed PorcuPi runtime receipt` diagnosis. It nevertheless refuses before changing owned state. The supported exact-target downgrade contract is provided by the invoking version-aware target: v0.2.0, for example, diagnoses itself as an unsupported downgrade when the receipt-verified installed runtime is newer. Invoking immutable v0.1.0 source code is tested separately as a mutation-free compatibility refusal; it is not retroactively treated as the npm-enabled interface established by ADR 0010.

Composition rollback swaps only retained Composition entries; it does not downgrade the installed PorcuPi runtime. Downgrade classification therefore uses the installed runtime identity, not the active Composition receipt, which may identify v0.1.0 after a valid Composition rollback.

## Consequences

- An intact historical v0.1.0 zero-Patch installation with empty Selection Intent can use the exact v0.2.0 Release Installation command directly.
- Readiness and cancellation are observable through the public process while the historical installation remains authoritative.
- Successful upgrade publishes a new Composition even when the Pi Base is unchanged because its receipt binds the target PorcuPi release.
- Existing optional `pi` ownership is preserved during upgrade and same-release verification.
- Arbitrary manager downgrade remains unsupported, while Composition rollback remains available independently.
- The immutable v0.1.0 source path is mutation-free when pointed at upgraded state but cannot retroactively provide the newer downgrade wording or pre-prompt interaction.
