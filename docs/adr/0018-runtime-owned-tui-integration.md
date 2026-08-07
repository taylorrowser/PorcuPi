# ADR 0018: Load one runtime-owned release-status TUI Integration

## Status

Accepted for Managed Pi release status in issue #53.

## Context

ADR 0001 requires a zero-Patch Managed Pi Composition to remain the exact pinned Pi Base. Managed Pi nevertheless needs one PorcuPi release-status row from its first usable TUI frame. Applying a hidden Patch or copying an Extension into the Composition payload would violate the zero-Patch guarantee, while placing the integration in Pi package settings would misrepresent runtime-owned behavior as user Selection Intent.

Release checking must not delay startup, enter conversation history, or turn update availability into upgrade readiness or lifecycle authority. The later cached Upgrade Readiness and Tracked Branch status work remains outside this decision.

## Decision

The receipt-inventoried PorcuPi runtime owns exactly one `tui-integration.mjs`. For a Managed Pi session, the stable runtime preserves the caller's Pi arguments in order and appends Pi's public explicit `--extension` option naming that one fixed runtime path. Pi's one-shot package and resource-configuration commands are forwarded exactly and do not load the integration because they create no Managed Pi session. This includes Pi's `uninstall <source>` package-removal alias; only bare `porcupi uninstall` invokes PorcuPi's lifecycle removal. The runtime does not copy or link the integration into the immutable Managed Pi Composition. The active Composition payload, receipt, Patch snapshot, Pi package settings, and Selection Intent therefore remain unchanged, including when zero Patches are selected.

This is a closed launch-time composition rule, not a PorcuPi privileged-extension facility. The integration accepts no configured module path and registers no tools, lifecycle commands, provider hooks, resource paths, or mutation callbacks. User and Pi Extension facilities remain Pi-owned and separate. `--no-extensions` may disable Pi discovery, but Pi's documented explicit-extension behavior still loads the fixed PorcuPi integration.

Pinned Pi v0.81.1 starts its TUI renderer before binding Extension UI callbacks and clears Extension widgets before it emits reload shutdown. During factory loading, the integration therefore installs one closed render guard on that exact Pi Base's `TUI.requestRender` interface. The guard leaves Pi's separate startup and project-trust TUI instances untouched, defers only the main interactive TUI's initial render requests, and binds the fixed component to Pi's existing above-editor widget container when it is registered. If Pi temporarily clears that container during reload or session replacement, the guard preserves the same component in the reserved row until the replacement runtime registers its component; it restores the exact original method on final session shutdown. If the verified executable's pinned TUI interface cannot be resolved, Extension loading fails rather than silently allowing a shifting row. This ensures the first emitted main-TUI frame and every lifecycle-transition frame already contain the reserved row without changing Composition bytes or exposing a configurable runtime hook.

At TUI session startup the integration synchronously reserves one one-line widget and renders cached release availability or `checking`, then permits the guarded widget-registration request to render the first frame. It performs at most one asynchronous request to the official `porcupi` npm release endpoint. Later in-process new, resumed, forked, or reloaded sessions reserve the row again from the current cache without starting another request or returning to `checking`. The request has a fixed timeout and bounded response body. A valid response atomically replaces a strict PorcuPi-owned availability cache. Failure is quiet, retains the last valid cache, and changes only the reserved row to unavailable/stale. Pi offline mode makes no request and renders the cached/offline state.

The row is recomputed for terminal width on every render, always returns exactly one line, and uses the current theme callback without retaining themed bytes. Theme invalidation, repeated rendering, network completion, and narrow widths therefore neither add nor remove layout rows. An available release shows `npx --yes porcupi@<exact-version>` and says it must run outside the current Managed Pi session. When the full prose does not fit but the exact command does, command-first rendering preserves that complete command before any optional prose is truncated.

The integration uses only widget state and never sends or appends a message or session entry. Availability checking may write only its strict informational cache; it does not acquire lifecycle authority or write Activation, runtime, launchers, Selection Intent, Pi settings, or Composition state. `porcupi status` is a separate network-free, side-effect-free reader for installed release/Pi Base, cached target release, freshness, and exact guidance.

The integration modules participate in the runtime inventory receipt. Full verification also validates the optional availability-cache schema. Conservative uninstall recognizes that one state file, binds it in the state inventory, and removes it with the PorcuPi ownership root while retaining all Pi-owned data.

## Consequences

- Zero-Patch Composition identity still means exact Pi Base payload bytes; Managed Pi behavior also includes one separately receipt-owned launch integration.
- Release availability is informational and does not claim Upgrade Readiness or activate an update.
- A corrupt cache cannot be repaired by startup checking; the row fails quiet, while `porcupi verify` and uninstall fail closed for inspection.
- A live Managed Pi Composition lease prevents uninstall from deleting the runtime while its integration or request is active.
- Future readiness and Tracked Branch status may extend the closed status model, but cannot turn this boundary into a configurable privileged-extension platform.
