# ADR 0008: Explicit reversible ownership of the `pi` entrypoint

## Status

Accepted for optional command ownership in issue #20.

## Context

PorcuPi must preserve independently installed Stock Pi by default while allowing a user to choose Managed Pi for the conventional `pi` command. Entrypoint ownership is local filesystem mutation outside the Managed Pi Composition, so enable, disable, interruption recovery, and collision handling require explicit ownership evidence.

## Decision

The guided installer asks whether PorcuPi should own `pi` and defaults to No. It always publishes and verifies the active Managed Pi Composition and stable `porcupi` launcher before attempting the optional alias. Immediate `porcupi pi enable` and `porcupi pi disable` operations use the shared lifecycle lock.

The optional alias is exactly `~/.local/bin/pi`. Its fixed shell bytes execute the absolute stable `~/.local/bin/porcupi` launcher with unchanged arguments. It never stores, invokes, renames, backs up, or falls back to Stock Pi. PorcuPi reports when PATH resolves another `pi` first and gives ordering remediation without changing PATH.

Enable uses exclusive hard-link publication and refuses every existing unowned regular file, symbolic link, directory, or other collision. A strict receipt under PorcuPi state binds ownership type, absolute path, regular-file kind, mode, size, and SHA-256. An exact owner-marked transition record precedes publication and binds the prepared temporary file, expected final receipt, and action. This permits retries to finish only an interrupted PorcuPi operation without adopting an identical unowned file.

Disable requires the strict receipt and exact unchanged alias bytes before removal. It verifies the PorcuPi ownership root but does not require a healthy stable launcher or active Composition, so alias removal remains available as recovery from Managed Pi corruption. It writes a receipt-bound disable transition before unlinking the alias and receipt. Recovery may complete either action only while transition, launcher, and receipt evidence agree. Modified, malformed, traversing, foreign, or symbolic substitutions are reported and left untouched.

Repeated enable and disable converge. Complete verification checks the optional alias whenever its ownership receipt exists and rejects a pending transition until a lifecycle operation recovers it. Disabling leaves `porcupi` intact; normal shell resolution may then find an independently installed Stock Pi, but PorcuPi does not discover or execute it as fallback.

## Consequences

- Installation preserves Stock Pi and declines `pi` ownership unless the user explicitly selects Yes.
- A Stock Pi elsewhere on PATH is never modified, even when the PorcuPi alias shadows it.
- A Stock Pi or any foreign entry already at `~/.local/bin/pi` blocks enable and is never adopted or moved.
- The alias reaches the same fail-closed activation, receipt, executable, launcher, and process-lease path as `porcupi`.
- Receipt and transition digests are local ownership/corruption evidence only; they do not authenticate code or provide a sandbox.
