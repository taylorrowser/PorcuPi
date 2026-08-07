# ADR 0011: v0.1.0 Release Installation upgrade

## Status

Accepted for the first cross-release upgrade in issue #42, extended to selected Artifacts in issue #43, hardened at publication boundaries in issue #44, and qualified for lossless Patch Selection Intent migration by ADR 0012 in issue #46.

## Context

PorcuPi v0.1.0 treats an owned active installation as a same-release recovery target. The first npm-enabled release must instead recognize an intact historical installation, assess a replacement without disturbing it, and switch the installed PorcuPi runtime and Managed Pi Composition without conflating Composition rollback with a manager downgrade.

The historical release has version-1 root ownership, Activation, Selection Intent, runtime and launcher receipts, and Composition receipts. Its receipt-inventoried runtime contains its exact `package.json`, so the installed PorcuPi release can be established without inferring it from a launcher or active Composition.

## Decision

Every npm-enabled, version-aware Release Installation target compares its exact invoking package version with the receipt-verified installed runtime version before showing an installation prompt:

- a matching version performs convergent verification without rebuilding or re-asking command ownership;
- a newer version enters the explicit upgrade journey; and
- an older version is refused as an unsupported PorcuPi downgrade.

The first migration contract is keyed by both endpoints: `PorcuPi 0.1.0 / state schema 1` to `PorcuPi 0.2.0 / state schema 1`. Issue #42 established its zero-Patch slice, and issue #43 completes that same endpoint contract for version-1 Selection Intent containing Patches and Pi resources. Publication-boundary interruption, corruption, and lease hardening belong to issue #44. A different source version, target version, or schema requires another explicit migration contract; a numerically newer installer alone is insufficient.

Before final confirmation, Release Installation runs a non-mutating Upgrade Readiness Check from the invoking release's fixed inputs. It resolves every retained Source Repository at its exact selected commit, proves each selected Artifact remains discoverable under the target Pi Base rules, verifies exact Patch digests and declared compatibility, and copies selected Patch bytes into the owner-marked stage. It also requires each selected global or project Pi resource group to retain its exact Pi-owned filtered package settings; it does not invoke Pi's package lifecycle. The staged selected Patches then pass the target's sequential Patch preflight, dependency, model-data, build, conformance, version, and smoke pipeline. The candidate Composition and runtime remain in the temporary stage. Cancellation or readiness failure removes that stage and leaves the installed runtime, launchers, Activation, published Compositions, Selection Intent, Pi settings/checkouts, and shared Pi/Stock Pi state unchanged.

After confirmation, PorcuPi commits an owner-marked upgrade transaction that binds both endpoint versions, source and target runtime receipts, source and migrated Activation, the verified candidate Composition receipt, Selection Intent bytes, stable and transition launcher receipts, and optional `pi` ownership. It publishes the verified target Composition, atomically transitions the stable launcher to a complete staged target runtime, replaces the receipt-inventoried runtime at the stable path, atomically replaces Activation, and restores the stable launcher target. The transition launcher keeps the public command on a complete recovery-capable runtime while the stable runtime directory is replaced; its receipt and the unchanged optional alias are verified before publication continues.

The new active entry names the target Composition built from current Patch Selection Intent and `previous` names the former active Composition. Pending Patch intent is therefore activated as part of the explicitly confirmed release upgrade. ADR 0012 permits the one lossless representation migration: version-1 individual Patch entries are transactionally rewritten as version-2 implicit one-file Patch Series without changing source, commit, path, digest, or selected bytes. Other Selection Intent remains semantically unchanged. Selected Pi resources retain their exact global or project Installation Scope and remain entirely under Pi lifecycle ownership. The target runtime reads the retained state schema, so the runtime-first switch does not expose an unreadable state shape.

The target installer and every target installed command recover an exact interrupted transaction under the shared lifecycle lock before ordinary behavior. ADR 0018 narrows this rule for the later `porcupi status` reader: status remains network-free and side-effect-free, does not recover or acquire the lifecycle lock, and may fail closed while a transaction is incomplete; the next installer or ordinary installed command performs recovery. Recovery validates every bound old-or-new runtime, receipt, launcher, optional alias, Activation, Selection Intent, candidate, and retained Composition and then monotonically finishes publication and ADR 0007 cleanup. A stage without a committed transaction is removable scratch only when its exact endpoint- and path-bound owner is intact. A malformed, changed, symbolic, escaping, or foreign stage or target is reported and left untouched. Existing Composition lease gates remain authoritative during cleanup, and a live process is never terminated. Narrow test-only faults cover migration preparation, candidate publication, launcher and receipt transitions, optional alias verification, target runtime and receipt publication, Activation replacement, and cleanup. Retry through the same exact-version Release Installation converges without manual deletion.

The target writes runtime-receipt schema 2 and accepts both historical schema 1 and target schema 2. Schema 2 is a compatibility fence against the immutable v0.1.0 source installer: that historical code predates version-aware Release Installation, prompts before inspecting an existing installation, and can report only its fixed `Malformed PorcuPi runtime receipt` diagnosis. It nevertheless refuses before changing owned state. The supported exact-target downgrade contract is provided by the invoking version-aware target: v0.2.0, for example, diagnoses itself as an unsupported downgrade when the receipt-verified installed runtime is newer. Invoking immutable v0.1.0 source code is tested separately as a mutation-free compatibility refusal; it is not retroactively treated as the npm-enabled interface established by ADR 0010.

Composition rollback swaps only retained Composition entries; it does not downgrade the installed PorcuPi runtime. Downgrade classification therefore uses the installed runtime identity, not the active Composition receipt, which may identify v0.1.0 after a valid Composition rollback.

## Consequences

- An intact historical v0.1.0 installation, including one with active or pending Patches and selected Pi resources, can use the exact v0.2.0 Release Installation command directly.
- Readiness inventories active and selected Patch identities, selected Artifact identities and Installation Scope, both Pi Bases, retained command ownership, and shared state while the historical installation remains authoritative.
- Successful upgrade publishes a new Composition even when the Pi Base is unchanged because its receipt binds the target PorcuPi release.
- Existing optional `pi` ownership is preserved during upgrade and same-release verification.
- Arbitrary manager downgrade remains unsupported, while Composition rollback remains available independently.
- The immutable v0.1.0 source path is mutation-free when pointed at upgraded state but cannot retroactively provide the newer downgrade wording or pre-prompt interaction.
