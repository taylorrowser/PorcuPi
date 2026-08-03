# ADR 0011: Transactional v0.1.0 Release Installation upgrade

## Status

Accepted for the first cross-release upgrade in issue #42.

## Context

PorcuPi v0.1.0 Release Installation treats an owned active installation as a same-release recovery target. The first npm-enabled release must instead recognize that intact historical installation, assess a replacement without disturbing it, and switch both the installed PorcuPi runtime and Managed Pi Composition without conflating Composition rollback with a manager downgrade.

The historical release has version-1 root ownership, Activation, Selection Intent, runtime and launcher receipts, and Composition receipts. Its runtime contains its exact `package.json`, so the installed PorcuPi release can be established from receipt-inventoried bytes rather than inferred from a launcher or the active Composition alone.

## Decision

Release Installation classifies an owned installation by comparing the exact invoking package version with the receipt-verified installed runtime version:

- a matching version performs guided convergent verification and recovery without rebuilding solely because the installer was invoked again;
- a newer version enters the explicit upgrade journey; and
- an older version is an unsupported PorcuPi downgrade and is refused before prompting or mutation.

The first versioned migration contract is `PorcuPi 0.1.0 / state schema 1` to `PorcuPi 0.2.0 / state schema 1`. This is an identity migration for retained control state: strict v0.1.0 Activation and Selection Intent are read by the target schema without adding fields or guessing information. The target preserves Selection Intent, Pi-owned package state, Stock Pi, and the existing optional `pi` ownership choice. A future source version or schema requires another explicit migration contract; merely having a numerically newer installer is insufficient.

Before final confirmation, Release Installation runs a non-mutating Upgrade Readiness Check from the invoking release's fixed inputs. For this contract it requires zero Patch Selection Intent and builds the exact zero-Patch target through the target's dependency, model-data, build, conformance, version, and smoke pipeline. The candidate Composition and target runtime remain in an owner-marked temporary stage. Cancellation or readiness failure removes that stage and leaves the installed runtime, launchers, Activation, published Compositions, Selection Intent, and shared Pi/Stock Pi state authoritative and unchanged.

After confirmation, PorcuPi publishes the receipt-verified target Composition, replaces the receipt-inventoried runtime with the target runtime at the stable runtime path, verifies the unchanged stable and optional launchers against that runtime, and atomically replaces Activation. The new active entry names the target zero-Patch Composition and `previous` names the former active Composition. The target runtime deliberately reads both source and target state schema 1, so the runtime-first switch cannot expose an unreadable old schema. Ordinary failures before Activation restore the prior runtime and receipt. Successful cleanup retains only the active and one previous Composition under ADR 0007.

Composition rollback swaps only the retained Composition entries; it does not downgrade the installed PorcuPi runtime. Therefore downgrade classification always uses the installed runtime identity, not the active Composition receipt, which may identify v0.1.0 after a valid Composition rollback.

## Consequences

- An intact historical v0.1.0 zero-Patch installation can use the exact v0.2.0 Release Installation command directly, without uninstalling first.
- Readiness and cancellation can be observed through the public process while the historical launcher remains usable and unchanged.
- Successful upgrade publishes a new Composition even when the Pi Base is unchanged because the Composition receipt binds the target PorcuPi release.
- Existing `pi` ownership is preserved rather than re-asked or silently defaulted during upgrade.
- Arbitrary manager downgrade remains unsupported; Composition rollback remains available independently.
- Supporting selected Patches or another source state schema requires a later explicit readiness and migration contract rather than permissive schema coercion.
