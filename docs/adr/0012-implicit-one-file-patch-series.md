# ADR 0012: Represent standalone Patch Files as implicit one-file Patch Series

## Status

Accepted for standalone Patch File evolution in issue #46. Declared multi-file series are added by ADR 0013 in issue #47.

## Context

ADR 0004 made each convention-discovered Patch File an individually selectable `Patch` Artifact. The Source Evolution model instead uses Patch Series as the selectable and updateable Patch Artifact. Existing simple sources must keep working without metadata, and existing v0.1 Selection Intent must not be regrouped or change selected bytes during migration.

Declared multi-file Patch Series, author-chosen identifiers, and explicit member order are separate work. Inferring a group from filenames, directories, adjacency, or prior selections would cross that boundary and make migration ambiguous.

## Decision

Every convention-discovered standalone Patch File not claimed by a declared series is represented as one implicit one-file Patch Series. Its stable source identity is the Patch File's full source-relative structural path. Its sole member binds the accepted Source Repository commit, the same structural path, and the SHA-256 of its exact bytes.

Add and manage present the implicit Patch Series as one selectable Patch Artifact. Patch Series have no Installation Scope and never enter Pi package settings. Selection Intent schema 2 records the series identity separately from its ordered member identity.

Apply deterministically flattens selected series by canonical Source Repository locator, series identity, and member order. Because an implicit series has one member whose identity is its structural path, this produces the same Patch File bytes and order as ADR 0005's accepted standalone-Patch ordering. Composition receipts and Activation Patch snapshots add the series identity to each flattened member.

Strict readers accept legacy receipt members without a series identity and interpret each as an implicit series identified by that member's path. Selection Intent schema 1 is validated before being migrated: each selected legacy Patch becomes exactly one implicit series with the same source, commit, path, and digest. A supported release upgrade writes schema 2 as part of its receipt-bound transaction; cancellation and interruption retain old-or-complete-new state. No grouping, source movement, or byte selection is guessed.

ADR 0004's convention discovery, path and regular-file rejection, digest, and narrow metadata rules remain authoritative for each standalone member. ADR 0005's fixed pipeline and activation boundary remain authoritative after flattening. ADR 0011's preservation rule is qualified only by the explicit lossless Selection Intent schema migration described here.

## Consequences

- Ordinary `patches/**/*.patch` sources remain zero-configuration sources.
- One standalone Patch File is displayed and managed as one Patch Series, while apply receives the same bytes in the same deterministic order.
- Selection Intent, Composition receipts, Activation, verification, rollback, uninstall, and pending comparison can distinguish series identity from exact member identity.
- Existing v0.1 selections migrate one-for-one without inferred grouping or selected-content changes.
- Moving a standalone Patch File changes its implicit series identity.
- ADR 0013 now defines declared multi-file series, author-chosen identifiers, and explicit member ordering without changing implicit-series behavior.
