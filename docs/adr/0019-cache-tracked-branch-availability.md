# ADR 0019: Cache read-only Tracked Branch availability

## Status

Accepted for Managed Pi Tracked Branch status in issue #55. This extends ADR 0018's fixed release-status row and completes the background-availability work deferred by ADRs 0015 and 0016. ADR 0017 remains authoritative for guided adoption.

## Context

Tracked Branch identity and guided selected-content review already exist, but users have to enter management to learn that relevant compatible selected content moved. Checking every repository serially in the TUI process would delay startup, while treating every branch head change as actionable would bypass ADR 0016's bounded inventory contract. Availability must remain useful offline without becoming lifecycle authority.

## Decision

At each online Managed Pi TUI startup, the runtime-owned integration starts one asynchronous Tracked Branch availability coordinator. The coordinator checks only Selection Intent sources with a canonical retained Tracked Branch; pinned tags, full commits, and migrated snapshots without proven branch identity are skipped. It runs at most three isolated source workers concurrently, gives each worker a fixed timeout, bounds captured output, and fails quietly.

Each worker calls the same candidate resolver, exact Pi Base compatibility filter, and structural fingerprint comparison used by `porcupi manage`. An unchanged head, irrelevant selected-content fingerprint, missing or incompatible selected Artifact, non-fast-forward movement, or failed resolution creates no new actionable entry. A later startup may resolve a newer compatible head and replace the prior informational result.

The coordinator atomically writes one strict PorcuPi-owned cache only after re-reading and matching complete Selection Intent. Cache identity binds the complete exact Selection Intent, receipt-inventoried installed runtime release, and exact active Pi Base used for compatibility evaluation. The manager release is never inferred from the active Composition receipt because Composition rollback does not downgrade the installed runtime. Each actionable entry binds the Source Repository locator, canonical Tracked Branch, accepted and candidate exact commits, changed selected-Artifact count, changed Patch Series count, and successful check time. A failed worker retains matching prior valid evidence for that source; a successful irrelevant or blocked result removes it. A changed Selection Intent, installed release, or Pi Base makes the whole prior cache nonmatching.

Overlapping coordinators serialize only two short cache-publication steps with a dedicated ephemeral lock. Before remote work, each reserves a monotonic cache generation after re-reading the exact inputs without replacing prior evidence for a different input identity. After remote work, it re-reads the latest matching cache and applies each successful worker outcome only when no later generation has already resolved that source. Successful non-candidates retain a source-generation tombstone so an older late candidate cannot resurrect removed evidence; failed workers leave prior evidence and its generation untouched. Cache arrays use the same code-point lexical ordering required by strict validation. This is informational cache coordination rather than lifecycle authority; remote checks remain concurrent and outside the lock.

The fixed row summarizes one or many matching candidates in place and directs the user to `porcupi manage`. Network-free `porcupi status` expands every candidate and explains that accepting changed Patch Series makes them pending until explicit `porcupi apply`. Offline startup performs no release, source, or readiness network work and displays matching cached source status.

Availability checking and display can write only this informational cache and its ephemeral publication lock. They never acquire lifecycle authority, move an accepted source snapshot, reconcile Pi packages, write Pi settings, change Selection Intent or Activation, build a Composition, or apply a Patch Series. Guided management re-resolves, reviews, and revalidates the exact candidate under ADR 0017 before mutation.

The cache participates in full verification, conservative state inventory, and uninstall beside the release-availability and Upgrade Readiness caches. Uninstall holds the publication lock inside its existing lifecycle transaction, preventing a late background cache write and removing that ephemeral lock after the ownership root is gone.

## Consequences

- Startup remains responsive while installations with several Tracked Branches are checked with explicit concurrency and timeout bounds.
- Status uses exactly the same effective selected-content contract as guided management rather than introducing a weaker detector.
- Documentation, tests, unrelated files, pinned sources, and incompatible movement remain quiet.
- Cached candidate evidence is useful offline but cannot authorize adoption or activation.
- One source failure cannot suppress newly resolved candidates from independent sources, and later successful checks can refresh that source.
