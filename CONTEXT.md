# PorcuPi

PorcuPi adds individual resource selection to Pi's Git package lifecycle and builds an isolated Managed Pi from explicitly selected Patch Series without taking ownership of Stock Pi.

## Language

**Release Installation**:
The primary one-command path for manually installing or upgrading to a specific PorcuPi release from its official npm artifact without first cloning its Source Repository. npm delivers and launches the installer but does not own the installed PorcuPi lifecycle. Release Installation never implies automatic updates or a mutable release channel. GitHub remains the canonical source and release record, and the exact-tag source installation remains an advanced audit and fallback path.
_Avoid_: Convenience install, quick install

**Update Availability Check**:
A lightweight, non-mutating check for a newer PorcuPi release or a newer eligible commit on a Tracked Branch. Availability does not imply readiness.
_Avoid_: Readiness check, automatic update

**Inter-release Source Update**:
A reviewed move to a newer exact commit on a Tracked Branch while retaining the current PorcuPi release and Pi Base. The candidate may update selected Patch Series and non-Patch Artifacts but is adopted only after compatibility checks and explicit confirmation.
_Avoid_: Package update, branch pull

**Post-release Compatibility Update**:
A Tracked Branch update published after a target PorcuPi release becomes available that makes selected Artifacts compatible with that release's Pi Base. It can change a previously blocked Upgrade Readiness Check to ready.
_Avoid_: Automatic patch migration

**Upgrade Readiness Check**:
A non-mutating assessment of whether one exact target PorcuPi release can preserve the current Selection Intent and produce a valid replacement Managed Pi. A cached result is advisory, bound to the exact target, Selection Intent, Patch Series identities, and platform, and must be revalidated before activation.
_Avoid_: Update check, automatic upgrade

**Source Repository**:
A Git repository from which PorcuPi discovers selectable Artifacts. Non-Patch resources must be compatible with Pi's package discovery or manifest rules.
_Avoid_: Registry, package feed

**Tracked Branch**:
A Source Repository branch retained as an update channel while Selection Intent remains bound to one exact resolved commit. Branch movement may produce a reviewed update candidate but never silently retargets installed Artifacts. An omitted source ref tracks the default branch; tags and full commits remain pinned.
_Avoid_: Installed branch, automatic update

**Artifact**:
An individually selectable Skill, Extension, Prompt, Theme, or Patch Series identified by its Source Repository, kind, and stable source identity—not by its display or runtime name. An Artifact may declare exact Pi Base compatibility; omission declares no author restriction.
_Avoid_: Repository, package

**Selection Intent**:
A retained direct request for one Artifact. A non-Patch-Series Selection Intent includes Pi's global or project package scope; a Patch Series Selection Intent applies only to Managed Pi.
_Avoid_: Dependency root, installed package

**Installation Scope**:
The Pi package configuration context in which a Skill, Extension, Prompt, or Theme is selected: user-global or project-local. Patch Series do not have an Installation Scope.
_Avoid_: Patch scope

**Patch File**:
One declarative Git-compatible source change used as an ordered member of a Patch Series. A Patch File does not supply executable hooks, build recipes, or dependency behavior.
_Avoid_: Plugin, build script

**Patch Series**:
One selectable and updateable Artifact containing an explicitly ordered list of one or more Patch Files for deterministic application to the Pi Base. A declared Patch Series has an author-chosen stable identifier that persists across Tracked Branch commits while its display name and contents may change. Membership, order, bytes, and compatibility are reviewed as one unit; a single-file change is a one-file Patch Series.
_Avoid_: Patch package, squashed patch

**Pi Base**:
The one exact official Pi source revision supported and pinned by a PorcuPi release. Patch selection never chooses or changes the Pi Base.
_Avoid_: Stock Pi version, automatically selected Pi version

**Managed Pi Composition**:
An immutable runnable payload built from the Pi Base and the deterministically ordered Patch Files in the selected Patch Series. Managed Pi activates one Managed Pi Composition as a whole and retains one previous composition for explicit rollback.
_Avoid_: Downstream Release, patched package

**Managed Pi**:
The isolated, PorcuPi-owned Pi installation that runs the active Managed Pi Composition without modifying Stock Pi.
_Avoid_: Patched Stock Pi, PorcuPi instance

**PorcuPi TUI Integration**:
The one narrow, always-loaded PorcuPi-controlled integration that displays update and readiness status and guidance inside Managed Pi. It is not a general privileged extension mechanism and does not enter Pi package settings or Selection Intent.
_Avoid_: Built-in package, mandatory user Extension

**Stock Pi**:
An independently installed Pi distribution owned by another installer or package manager.
_Avoid_: Fallback Pi, unmanaged Pi
