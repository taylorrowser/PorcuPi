# ADR 0011: Transactional v0.1.0 Release Installation upgrade

## Status

Accepted for the first cross-release upgrade in issue #42.

## Context

PorcuPi v0.1.0 Release Installation treats an owned active installation as a same-release recovery target. The first npm-enabled release must instead recognize that intact historical installation, assess a replacement without disturbing it, and switch both the installed PorcuPi runtime and Managed Pi Composition without conflating Composition rollback with a manager downgrade.

The historical release has version-1 root ownership, Activation, Selection Intent, runtime and launcher receipts, and Composition receipts. Its runtime contains its exact `package.json`, so the installed PorcuPi release can be established from receipt-inventoried bytes rather than inferred from a launcher or the active Composition alone.

## Decision

Release Installation classifies an owned installation by comparing the exact invoking package version with the receipt-verified installed runtime version:

- a matching version performs convergent verification and recovery without rebuilding or re-asking command ownership solely because the installer was invoked again;
- a newer version enters the explicit upgrade journey; and
- an older version is an unsupported PorcuPi downgrade and is refused before prompting or mutation.

The first versioned migration contract is `PorcuPi 0.1.0 / state schema 1` to `PorcuPi 0.2.0 / state schema 1`. This is an identity migration for retained control state: strict v0.1.0 Activation and Selection Intent are read by the target schema without adding fields or guessing information. The target preserves Selection Intent, Pi-owned package state, Stock Pi, and the existing optional `pi` ownership choice. A future source version or schema requires another explicit migration contract; merely having a numerically newer installer is insufficient.

Before final confirmation, Release Installation runs a non-mutating Upgrade Readiness Check from the invoking release's fixed inputs. For this contract it requires zero Patch Selection Intent and builds the exact zero-Patch target through the target's dependency, model-data, build, conformance, version, and smoke pipeline. The candidate Composition and target runtime remain in an owner-marked temporary stage. Cancellation or readiness failure removes that stage and leaves the installed runtime, launchers, Activation, published Compositions, Selection Intent, and shared Pi/Stock Pi state authoritative and unchanged.

After confirmation, PorcuPi publishes the receipt-verified target Composition and migrates the runtime without ever removing the stable runtime path. The explicit v0.1.0-to-v0.2.0 runtime contract proves that both inventories have the same paths and that only `runtime.mjs`, `install.mjs`, and `package.json` differ. Those source/target-compatible regular files are durably replaced one at a time by same-directory atomic rename, with the package identity replaced last. The stable `porcupi` launcher therefore always resolves a complete CLI during interruption; the optional `pi` alias remains unchanged because it delegates to that launcher. Retry uses the owner-marked stage to reapply all target files idempotently before continuing, while an ordinary caught failure restores the three prior files and receipt.

The target runtime accepts historical runtime-receipt schema 1 for upgrade preflight and writes schema 2 after publication. Schema 2 is also a compatibility fence: the immutable v0.1.0 installer rejects a successfully upgraded installation during its strict runtime verification, before it can reconcile command ownership. The v0.2.0 installer verifies the target runtime and unchanged launchers, then atomically replaces Activation. The new active entry names the target zero-Patch Composition and `previous` names the former active Composition. Both runtimes read state schema 1, so any compatible file-publication intermediate and the runtime-first switch can read the old Activation. Successful cleanup retains only the active and one previous Composition under ADR 0007.

Composition rollback swaps only the retained Composition entries; it does not downgrade the installed PorcuPi runtime. Therefore target-version downgrade classification always uses the installed runtime identity, not the active Composition receipt, which may identify v0.1.0 after a valid Composition rollback. The immutable historical installer cannot perform that future version comparison, so the schema-2 runtime-receipt fence supplies its mutation-free refusal.

## Consequences

- An intact historical v0.1.0 zero-Patch installation can use the exact v0.2.0 Release Installation command directly, without uninstalling first.
- Readiness and cancellation can be observed through the public process while the historical launcher remains usable and unchanged.
- Successful upgrade publishes a new Composition even when the Pi Base is unchanged because the Composition receipt binds the target PorcuPi release.
- Existing `pi` ownership is preserved rather than re-asked or silently defaulted during upgrade, same-release verification, or interrupted recovery.
- Hard interruption at any contracted runtime-file publication leaves the stable launcher usable and retry converges without re-running command-ownership review.
- Arbitrary manager downgrade remains unsupported; the exact historical installer is fenced before mutation, and Composition rollback remains available independently.
- Supporting selected Patches or another source state schema requires a later explicit readiness and migration contract rather than permissive schema coercion.
