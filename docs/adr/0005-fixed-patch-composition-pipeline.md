# ADR 0005: Fixed Patch composition pipeline and atomic activation

## Status

Accepted for `porcupi apply` in issue #17. Its standalone-Patch ordering is generalized to declared Patch Series by ADR 0013 in issue #47.

## Context

Patch Selection Intent is retained separately from the active Managed Pi Composition. Turning that pending intent into runnable code executes selected source changes and fixed build commands with the user's authority, so the transition must be explicit, deterministic, receipt-bound, and unable to disturb the working composition on failure.

Patch sources must not gain a build interface. Preflight and build must also consume identical bytes rather than refetching or rereading files between passes.

## Decision

`porcupi apply` previews the canonical Patch flattening and requires one terminal confirmation. ADR 0013 orders selected series lexically by `(canonical Source Repository locator, stable series identity)` and preserves declared member order within each series; implicit one-file series therefore retain the original full-path order. Zero Patch Files is valid.

After confirmation, PorcuPi resolves each retained package source to its retained full commit inside an owner-marked apply stage. It verifies the canonical locator, commit, convention-discovered regular-file path, and SHA-256, then copies each Patch into a canonically numbered staged file and verifies that copy. Both later passes use only those staged bytes.

For a nonempty series, PorcuPi clones the exact Pi Base into an isolated preflight checkout. For each Patch in order it runs `git apply --check --whitespace=error-all`, then applies that Patch before checking the next. Only a completely successful preflight permits a separate exact Pi Base build checkout. The build checkout applies the identical series in the identical order and runs the release-fixed recipe: `npm ci --ignore-scripts`, verified pinned model-data hydration, `check:model-data`, `build:offline`, public `--help` conformance, exact `--version`, and isolated-home `--list-models` smoke.

The resulting payload is made read-only before inventory. One receipt binds schema version, PorcuPi version, exact Pi Base, ordered Patch locator/commit/path/digest identities, fixed recipe, platform/architecture, required executable identity, and normalized complete payload inventory. Its canonical identity determines the Composition ID. Matching embedded and central receipts and a complete inventory are required for identity reuse.

Publication is a same-filesystem rename of the complete immutable candidate and precedes one atomic activation-record replacement. The new record commits the candidate's Patch snapshot as active and the complete former active entry as previous. Selection Intent is unchanged. If the fully verified active receipt already binds the requested series and current release recipe, apply reports a no-op without fetching or rebuilding.

Apply stages carry exact ownership evidence. Ordinary failure removes only the current owned stage. On retry, PorcuPi removes only stale apply stages with matching ownership evidence. Narrow test-only interruption checkpoints exist only after complete Composition publication and after atomic activation replacement, so observable state is old or complete new state.

## Consequences

- Patch source metadata cannot change commands, checks, order, dependencies, or failure policy.
- Sequential dependencies between Patches work only in the one canonical order; an order-sensitive set requiring another order is invalid.
- Fetch, digest, preflight, apply, install, hydration, build, conformance, smoke, receipt, or pre-activation publication failure leaves active and previous unchanged.
- A publication may exist before activation after interruption, but it is complete and receipt-verifiable; a retry converges without treating location alone as ownership.
- Commits, digests, receipts, and inventories provide reproducibility and local-integrity evidence, not publisher authentication or sandboxing.
