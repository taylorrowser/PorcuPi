# ADR 0013: Select declared Patch Series by stable identity and ordered inventory

## Status

Accepted for declared Patch Series in issue #47.

## Context

ADR 0012 represents every unclaimed convention-discovered Patch File as an implicit one-file Patch Series. Coordinated changes still need one selectable identity that survives member path and display changes while preserving reviewable Patch Files and author-declared dependency order.

Grouping cannot be inferred from filenames, directories, adjacency, or prior Selection Intent. A declaration also must not weaken ADR 0004's exact Git inventory and repository-boundary checks or ADR 0005's fixed staging, preflight, build, verification, and activation pipeline.

## Decision

A regular root `porcupi.json` schema 1 may contain a `patchSeries` array. Each entry has exactly these fields:

```json
{
  "id": "wait-for-user",
  "displayName": "Wait for user",
  "description": "Optional presentation text.",
  "members": [
    "patches/0001-question-tool.patch",
    "patches/0002-wait-state.patch"
  ]
}
```

`id` is a nonempty, control-free, source-local stable identity. `displayName` and `description` are optional nonempty, control-free presentation text and are not retained in Selection Intent. `members` is a nonempty ordered array of source-relative `patches/**/*.patch` paths. Unknown fields invalidate the metadata overlay as a whole.

Each member must be unique within its declaration and must resolve at the accepted exact Source Repository commit to a tracked `100644` or `100755`, repository-bounded regular Patch File. Unsafe, missing, symbolic, Git-submodule, special-mode, boundary-escaping, and non-regular members invalidate that declaration with a visible diagnostic. If a member is claimed by multiple declarations, every conflicting declaration is invalid. A declared identifier also cannot collide with the structural identity of an unclaimed implicit series. Invalid declarations claim no files, so otherwise valid convention-discovered files remain available as implicit one-file series. A valid declared member is never also emitted as an implicit series.

The declared stable identifier is the Artifact identity. Changing display text, description, member paths, order, or bytes preserves identity and is reviewed as one series inventory change. Changing `id` creates a different Artifact. Selection Intent binds the identifier and the complete ordered member inventory; every member binds the accepted source commit, structural path, and SHA-256 of exact bytes.

Apply sorts selected series lexically by canonical Source Repository locator and stable series identifier, then preserves each declaration's member order. It stages every exact member byte sequence once and runs ADR 0005's unchanged sequential preflight and fixed composition pipeline over the flattened list. Composition identity, embedded and central receipts, and Activation Patch snapshots preserve that complete flattened order and repeat the stable series identifier on every member.

The existing `patches` metadata array remains the optional presentation and exact Pi Base compatibility overlay for implicit one-file series. An entry for a Patch File claimed by a valid declaration does not create another Artifact and is visibly ignored. Broader source defaults and per-Artifact compatibility are deferred to issue #48.

## Consequences

- Source authors can publish single-file or coordinated multi-file declared Patch Series without squashing reviewable changes.
- Add and manage expose one selection per declared series, never one selection per member.
- Reordering or moving members changes pending series inventory without changing stable identity.
- Canonical cross-series order remains manager-owned while dependency order within a declared series is author-controlled data, not executable policy.
- Metadata still cannot supply commands, hooks, dependencies, recipes, force behavior, custom verifiers, or activation policy.
- Existing implicit one-file series and migrated v0.1 selections retain their accepted structural-path identities and byte ordering.
