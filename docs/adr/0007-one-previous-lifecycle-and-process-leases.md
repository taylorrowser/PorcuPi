# ADR 0007: One-previous lifecycle, serialized mutation, and process leases

## Status

Accepted for rollback and retention in issue #19.

## Context

Atomic activation retains one previous Managed Pi Composition, but retention is safe only if rollback verifies its local target, lifecycle mutations cannot overlap, and cleanup cannot race an ordinary launch that already selected a Composition. Location alone is not ownership evidence, and a process may continue running an older Composition after activation changes.

## Decision

`porcupi rollback` is a guided local operation. It displays the active and optional previous Composition, requires one explicit confirmation when a target exists, fully verifies the target's matching central and embedded receipts and complete payload inventory, verifies its committed Patch snapshot, and atomically swaps the complete active and previous entries. It performs no fetch or build and does not alter Patch Selection Intent.

Install, apply, rollback, future launcher-ownership mutation, cleanup, and uninstall use one adjacent lifecycle lock. The lock is an atomically hard-linked, exact owner record containing the operation, process ID, and nonce. A live owner makes a competing mutation fail closed; an exact dead owner is recovered. A malformed, symbolic, or changed lock is foreign and is not removed. Ordinary launch does not take this lock.

Every published Composition has a separate owner-marked lease directory. Launch reads strict Activation state, creates an exclusive process lease for the selected Composition, and only then resolves and verifies the Composition payload. If cleanup has already closed that lease directory, launch rereads Activation and retries. The launcher process retains the lease while its child Pi process runs and removes only its exact lease record afterward.

After a successful switch, cleanup keeps the active and previous Compositions. For each older unreferenced Composition, it requires matching strict central and embedded receipts, complete payload verification, and an exact lease-directory owner. Cleanup atomically moves the lease directory out of the claim path before checking leases. A live, malformed, or foreign lease restores the gate and defers deletion. Exact dead leases are removed.

Deletion uses an owner-marked cleanup stage under PorcuPi temporary state. Once an unleased Composition is moved there, the central receipt is durably removed and then the stage is removed. Recovery either restores a referenced staged Composition or finishes deletion only when the stage owner, embedded receipt, optional central receipt, complete payload, and staged lease ownership all agree. Unknown, modified, malformed, escaping, or symbolic paths are left untouched.

## Consequences

- Rollback always selects one already-published local Composition and can toggle between the retained pair without network or build work.
- Patch Selection Intent can remain pending across rollback and a later `porcupi apply` can restore it.
- Activation interruption exposes either the old or complete swapped record; cleanup interruption leaves an owner-proven recoverable stage.
- Existing ordinary launches continue during lifecycle mutation, and an older running Composition defers its own deletion.
- Retention converges to active plus previous during a later lifecycle operation after live leases exit.
- Same-user processes remain inside PorcuPi's local trust boundary; leases and receipts provide race prevention and local ownership evidence, not sandboxing or authentication.
