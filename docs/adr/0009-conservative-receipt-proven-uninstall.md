# ADR 0009: Conservative receipt-proven uninstall

## Status

Accepted for guided uninstall in issue #21.

## Context

PorcuPi owns launchers and a local Managed Pi root, but Pi owns resource package configuration, checkouts, credentials, sessions, and project trust. Stock Pi is independently owned. Uninstall must cross the Managed Pi root and command directory without treating path location as ownership, racing a running Composition, or leaving an interrupted removal impossible to finish.

## Decision

`porcupi uninstall` uses the shared lifecycle lock and a three-page guided flow. Before prompting, it validates the exact root owner and directory schema; runtime inventory receipt; stable and optional `pi` launcher receipts and bytes; Activation and Selection Intent schemas; matching central and embedded Composition receipts; complete payload inventories; exact lease ownership; known temporary/cleanup owners; path containment; and symbolic-link boundaries. Unknown, changed, malformed, traversing, or substituted targets make the command fail without deletion.

The flow inventories the Pi resource groups recorded in Selection Intent and checks whether each exact global or project package entry still matches. It reports those groups as retained or externally changed. Uninstall never invokes Pi package lifecycle operations and never writes Pi global/project settings, package directories, credentials, sessions, project trust/resources, or Stock Pi. PorcuPi's combined Selection Intent disappears with its state root; Pi's independently owned resource configuration and payloads remain.

After confirmation, PorcuPi publishes an adjacent, exact-owner uninstall tombstone. The tombstone contains a verified copy of the installed runtime, original and recovery launcher identities, exact Composition identities, runtime/control/temporary inventory digests, and the retained-resource report. The stable launcher is atomically changed from its verified installed bytes to verified recovery bytes that target the tombstone runtime. This keeps `porcupi uninstall` retryable after the Managed Pi root is removed. No foreign launcher collision is adopted.

Before deletion, all Composition lease directories are atomically moved into tombstone lease gates. A lease created before a gate move is observed there; a launch arriving afterward cannot claim the closed path. Any live lease restores every gate and defers uninstall without terminating the Pi process or removing a payload or launcher. With no live lease, PorcuPi revalidates the root against the tombstone snapshot, removes an unchanged optional `pi` alias, publishes the recovery launcher, removes the proven root, removes the unchanged recovery launcher, and finally removes the tombstone.

Narrow test-only faults exist only after tombstone publication, lease gating, optional-alias removal, recovery-launcher publication, root removal, launcher removal, and tombstone removal. Retry validates the tombstone and resumes the monotonic transaction. Exact owner-marked incomplete tombstone preparations may be discarded. A foreign or changed preparation/tombstone is left untouched. Once root and tombstone are absent, uninstall is an idempotent no-op.

## Consequences

- Cancellation changes neither PorcuPi nor shared Pi/Stock Pi state and restores terminal mode and cursor visibility.
- Uninstall is intentionally fail closed: one unproven intended target prevents destructive work rather than being guessed, repaired, overwritten, or force-removed.
- The runtime now has a complete inventory receipt, allowing uninstall and full verification to detect local runtime additions, removals, and modifications before deleting it.
- Live Managed Pi continues normally and a later explicit retry converges after its lease exits.
- Tombstone receipts and digests are local ownership, corruption, and recovery evidence only. They do not authenticate publishers, establish provenance, or sandbox code.
