# ADR 0017: Coordinate source updates as independent transactions

## Status

Accepted for multi-source and mixed-scope Inter-release Source Updates in issue #52. This decision extends ADR 0016's single-source candidate adoption without changing its structural fingerprint contract.

## Context

One installation can retain several Source Repositories, each with global and project Pi resources and pending Patch Series. A candidate, blocker, cancellation, trust denial, or package failure for one source must not overwrite another source's accepted exact snapshot or prevent the user from choosing another reviewable source.

Pi package reconciliation can cross global and project settings while Patch Selection Intent spans every source. Source adoption therefore needs one transaction boundary that preserves Pi's package and project-trust ownership while keeping the active Managed Pi unchanged.

## Decision

`porcupi manage` resolves every advanced Tracked Branch independently. When several sources have advanced, it presents their changed, unchanged-forced-review, or blocked status and lets the user choose one reviewable Source Repository. Review and final revalidation remain bound to that source's one exact candidate commit and complete structural fingerprint. Cancellation from the source chooser or any candidate review page performs no mutation.

Acceptance replaces exactly one source record in the complete aggregate Selection Intent. The replacement contains that source's latest explicitly accepted exact snapshot; every other source record remains byte-for-byte semantically intact. A later accepted snapshot for the same source replaces its earlier pending snapshot rather than appending a delta. Accepted snapshots from other sources coexist and `porcupi apply` consumes their complete canonical Patch Series combination.

For selected Pi resources, one source acceptance reconciles every affected global and project Installation Scope through Pi's public package lifecycle. PorcuPi stages exact narrowed settings, never supplies project approval, and saves Selection Intent only after all package operations and settings verification succeed. Failure restores every prior settings snapshot and attempts to reconcile affected checkouts to each prior exact package source. Project trust remains Pi-owned; denial commits no source snapshot.

The complete `porcupi manage` operation, including candidate resolution, guided review, final revalidation, package reconciliation, and Selection Intent save, holds ADR 0007's shared lifecycle lock. It therefore serializes source mutation with Release Installation and upgrade recovery, apply, rollback, `pi` ownership, Composition cleanup, and uninstall.

Source acceptance never writes Managed Pi Activation. Patch changes remain pending until explicit `porcupi apply`. Apply failure leaves the aggregate latest accepted Selection Intent available for correction or retry.

## Consequences

- A blocked or cancelled source does not make another reviewable source unreachable.
- Global and project package settings cannot commit different source snapshots through a partial source acceptance.
- Pending Patch Series from several sources form one deterministic desired snapshot, not a queue of update deltas.
- Holding the lifecycle lock across network resolution and human review favors a simple fail-closed mutation boundary over concurrent lifecycle throughput.
- Pi remains authoritative for package realization and project trust, and ADR 0005 remains authoritative for Patch activation.
