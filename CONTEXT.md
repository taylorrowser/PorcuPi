# PorcuPi

PorcuPi adds individual resource selection to Pi's Git package lifecycle and builds an isolated Managed Pi from explicitly selected source patches without taking ownership of Stock Pi.

## Language

**Source Repository**:
A Git repository from which PorcuPi discovers selectable Artifacts. Non-Patch resources must be compatible with Pi's package discovery or manifest rules.
_Avoid_: Registry, package feed

**Artifact**:
An individually selectable Skill, Extension, Prompt, Theme, or Patch identified by its Source Repository, kind, and source-relative structural path—not by its display or runtime name.
_Avoid_: Repository, package

**Selection Intent**:
A retained direct request for one Artifact. A non-Patch Selection Intent includes Pi's global or project package scope; a Patch Selection Intent applies only to Managed Pi.
_Avoid_: Dependency root, installed package

**Installation Scope**:
The Pi package configuration context in which a Skill, Extension, Prompt, or Theme is selected: user-global or project-local. Patches do not have an Installation Scope.
_Avoid_: Patch scope

**Patch**:
A declarative Git-compatible source change explicitly selected for deterministic application to the Pi Base. A Patch does not supply executable hooks, build recipes, or dependency behavior.
_Avoid_: Plugin, build script

**Pi Base**:
The one exact official Pi source revision supported and pinned by a PorcuPi release. Patch selection never chooses or changes the Pi Base.
_Avoid_: Stock Pi version, automatically selected Pi version

**Managed Pi Composition**:
An immutable runnable payload built from the Pi Base and the deterministically ordered selected Patches. Managed Pi activates one Managed Pi Composition as a whole and retains one previous composition for explicit rollback.
_Avoid_: Downstream Release, patched package

**Managed Pi**:
The isolated, PorcuPi-owned Pi installation that runs the active Managed Pi Composition without modifying Stock Pi.
_Avoid_: Patched Stock Pi, PorcuPi instance

**Stock Pi**:
An independently installed Pi distribution owned by another installer or package manager.
_Avoid_: Fallback Pi, unmanaged Pi
