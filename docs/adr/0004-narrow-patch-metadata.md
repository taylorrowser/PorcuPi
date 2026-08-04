# ADR 0004: Convention-only Patch discovery and narrow metadata

## Status

Accepted for Patch Selection Intent in issue #16. Qualified for explicitly confirmed cross-release upgrades by ADR 0011 in issue #43, implicit one-file Patch Series representation by ADR 0012 in issue #46, and declared Patch Series by ADR 0013 in issue #47.

## Context

PorcuPi needs to discover exact declarative Patches without introducing a package registry, executable source manifest, dependency graph, compatibility solver, or source-defined build interface. A source maintainer may still need to improve Patch presentation and state exact compatibility with PorcuPi's one release-pinned Pi Base.

Git trees can also contain symbolic links and gitlinks. Following either during discovery would let a structural Patch path change meaning or cross the exact Source Repository boundary.

## Decision

PorcuPi obtains the tracked Git index for the resolved exact Source Repository commit and recursively discovers only `100644` or `100755` files whose full source-relative paths are beneath root `patches/` and end in `.patch`. It rejects symbolic links, Git submodules, unsupported modes, unsafe paths, non-regular working-tree entries, and real paths outside the checkout. Each discovered Patch receives a SHA-256 over its exact bytes. ADR 0012 evolves its Artifact representation into an implicit one-file Patch Series: the full structural path is the series identity, while retained intent additionally binds the exact member source commit, path, and SHA-256.

A Source Repository may optionally contain this versioned root `porcupi.json` shape:

```json
{
  "schemaVersion": 1,
  "patches": [
    {
      "path": "patches/example.patch",
      "displayName": "Example change",
      "description": "Optional presentation text.",
      "supportedPiBaseVersions": ["v0.81.1"],
      "supportedPiBaseCommits": ["20be4b18d4c57487f8993d2762bace129f0cf7c6"]
    }
  ]
}
```

The root and each entry reject unknown fields. Entry paths must be safe convention-discovered Patch paths. Display fields must be non-empty text without control characters. Compatibility arrays, when present, must be non-empty sets of unique exact values: release tags for versions and full SHA-1 or SHA-256 commit object IDs for commits. When both dimensions are present, both must include the release's exact Pi Base. A declared mismatch disables selection. No compatibility declaration leaves the fixed preflight/build pipeline authoritative.

Malformed roots, duplicate entries, unsafe values, unsupported fields, ranges, or invalid compatibility values invalidate and prominently ignore the entire overlay. A valid entry for a path that is not a discovered regular Patch is reported and ignored individually. These `patches` overlay entries never add an Artifact; ADR 0013 separately defines the closed `patchSeries` declaration that groups discovered regular Patch Files into one Artifact.

Patch display metadata is not retained as Selection Intent. Add saves only kind, path, exact source commit, and digest, and it explicitly reviews changed selected Patch digests when replacing a source commit. Patches never receive Pi Installation Scope or enter Pi package configuration. Saving intent only reports whether its canonical ordered Patch snapshot differs from the active Managed Pi Composition; `porcupi apply` remains the sole build and activation command during ordinary same-release Selection Intent management. ADR 0011 defines one narrow exception: an explicitly confirmed, supported cross-release Release Installation builds and activates the replacement Managed Pi from the exact retained Patch Selection Intent, including pending intent, as part of the atomic release upgrade.

## Consequences

- Source-controlled metadata can improve presentation and reject a known-incompatible exact Pi Base without gaining executable authority.
- The `patches` overlay cannot declare dependencies, hooks, scripts, ordering, ranges, build recipes, verifiers, Artifact Sets, Runtime Support, or solver behavior. ADR 0013 separately permits data-only member order within a declared series.
- Missing or invalid metadata cannot suppress convention-discovered regular Patches. ADR 0013 permits strict metadata to claim regular Patch Files as ordered members of one declared Patch Series; unclaimed files retain this ADR's implicit-series behavior.
- Commit and SHA-256 bindings support reproducibility and local integrity; they do not authenticate a publisher or sandbox Patch-modified build commands.
