# ADR 0015: Retain Tracked Branches beside exact accepted snapshots

## Status

Accepted for Tracked Branch retention in issue #49. This decision amends ADR 0003's retained Selection Intent inventory by adding the optional canonical Tracked Branch identity; exact-commit Pi package delegation remains unchanged. Candidate review and adoption remain deferred to issues #50–#52.

## Context

PorcuPi already resolves a requested Source Repository ref to one full commit and stores only an exact package source. That preserves reproducibility but loses whether the user intentionally chose a mutable branch as an update channel. Retaining the mutable ref in Pi package settings would instead allow installed content to move outside PorcuPi's review and activation boundaries.

A branch-like name can also collide with a tag, a remote default can change, and historical v0.1 Selection Intent contains only an exact commit package source. Current remote topology is therefore not evidence of the ref that an existing user originally selected.

## Decision

When `porcupi add` resolves a named branch, Selection Intent retains its canonical full branch identity as `refs/heads/<name>` beside the exact accepted commit. When the request omits a ref, PorcuPi resolves the cloned remote's symbolic default branch and retains that canonical branch identity. Equivalent explicit branch spellings such as `origin/<name>`, `refs/heads/<name>`, and `refs/remotes/origin/<name>` collapse to the same identity.

A tag, including an explicitly qualified `refs/tags/<name>`, and a full commit object ID remain pinned and retain no Tracked Branch field. An unqualified full-length hexadecimal value uses commit syntax; a branch with that unusual name remains addressable through explicit `refs/heads/<name>` syntax. Any other unqualified name that resolves as both a branch and tag is rejected rather than classified by precedence. Missing or deleted refs and malformed or unresolved default branches are also rejected before review.

The retained branch is update-channel metadata only. The source-level Selection Intent, every Patch Series member, and every Pi package settings entry continue to bind the same credential-free package source at the exact accepted full commit. Add resolves and checks out that commit before discovery. Merely moving, deleting, or force-moving the remote branch performs no local mutation. Re-adding the same Tracked Branch rejects a non-fast-forward candidate because the accepted commit cannot be proven in its ancestry. It also rejects a changed channel identity, including a changed remote default or a branch name that now resolves only as a tag. Removing the old selection before adding a different channel keeps source retargeting explicit. Any later candidate check must preserve the accepted snapshot unless a separately specified guided review revalidates and accepts one exact candidate.

Manage labels each source as a Tracked Branch or pinned source and displays its accepted exact commit. Existing version-2 Selection Intent without a Tracked Branch remains valid and pinned. Migration from version-1 intent never infers a branch from a matching current remote ref; a user must explicitly re-add a branch to opt into tracking.

## Consequences

- Branch followers have a durable, canonical update channel without mutable installed content.
- Pi remains configured only with exact commits and cannot silently advance PorcuPi-selected resources.
- Tags, commits, and unproven migrated intent remain permanently pinned until an explicit user action selects a branch.
- Remote movement alone cannot change Selection Intent, pending Patch intent, Pi settings, or Managed Pi Activation.
- The existing explicit add review can still replace a fast-forward exact snapshot; automatic candidate detection, management-surface adoption, selected-content filtering, and repeated-update coalescing require their own guided and transaction-safe contracts.
