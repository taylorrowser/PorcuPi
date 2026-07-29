# ADR 0006: Cheap fail-closed launch and explicit full verification

## Status

Accepted for Managed Pi integrity enforcement in issue #18.

## Context

A Managed Pi Composition receipt binds a complete payload, but hashing that complete payload and rerunning Pi checks on every invocation would make ordinary launch unnecessarily expensive. Checking too little would permit malformed control state, receipt substitution, an altered executable, or a foreign launcher to run implicitly.

PorcuPi must distinguish quick checks that make launch fail closed from a complete on-demand local-integrity audit. Neither class of check authenticates a publisher or provides a sandbox.

## Decision

Every Managed Pi operation begins from a strict PorcuPi ownership root. Readers require exact versioned object shapes and reject unknown or missing fields, malformed identities, duplicate or traversing paths, noncanonical ordered Patch and payload identities, symbolic-link substitution of control files or owned directories, and paths that resolve outside the ownership root.

Normal launch validates the root and Activation, active Composition identity, matching central and embedded receipts, receipt self-identity, platform/architecture, committed Patch snapshot, payload and executable paths, exact required-executable kind/mode/size/SHA-256, and the stable launcher ownership receipt. It does not hash every payload entry. Any detected mismatch refuses launch without trying the retained previous Composition or Stock Pi and prints explicit verify, rollback, and direct Stock Pi recovery guidance.

`porcupi verify` repeats those checks, recomputes the normalized complete payload inventory, and requires it to exactly match the active receipt. It then reruns the fixed public `--help` conformance check, exact `--version`, and isolated-home `--list-models` smoke check. Its owner-marked temporary home is removed after success or failure.

The stable launcher has a strict receipt under PorcuPi state that records its PorcuPi ownership type, exact expected path, regular-file kind, mode, size, and SHA-256. The bytes must also be the release-generated command that invokes PorcuPi's installed runtime. Verification reports mismatch and never repairs or replaces the launcher. Installation recovery may create a missing receipt only when converging an interrupted installation whose exact expected launcher and active installation already exist.

## Consequences

- Ordinary launch stays cheap and must not be described as a complete file audit.
- A changed non-executable payload file can remain undetected by normal launch until explicit verification; a changed required executable is rejected before execution.
- Complete verification detects missing, added, or changed payload entries and reruns executable behavior checks in an isolated home.
- No integrity failure silently falls back to another Managed Pi Composition or Stock Pi.
- Commits, digests, receipts, inventories, and ownership markers provide reproducibility and local-corruption evidence only. They do not prove publisher identity, provenance, or safety of executed code.
