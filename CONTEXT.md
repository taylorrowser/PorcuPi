# PorcuPi

PorcuPi manages Pi-specific artifacts and an isolated patched Pi without taking ownership of an independently installed Pi.

## Language

**Source Repository**:
A Git repository from which PorcuPi discovers selectable artifacts. A source repository may use Pi conventions without containing PorcuPi-specific metadata.
_Avoid_: Registry, package feed

**Artifact**:
An individually selectable skill, extension, prompt, or patch discovered in a Source Repository.
_Avoid_: Repository, package

**Artifact Revision**:
The exact content PorcuPi would install for one Artifact, identified independently of unrelated changes elsewhere in its Source Repository. The source Git commit is provenance for the revision, not its content identity.
_Avoid_: Repository revision, package version

**Installation Scope**:
The Pi discovery context in which a skill, extension, or prompt is installed: user-global or project-local. Patches do not have an Installation Scope; they apply to Managed Pi.
_Avoid_: Patch scope

**Managed Pi**:
An isolated, PorcuPi-owned Pi installation composed from selected patches and activated without modifying Stock Pi.
_Avoid_: Patched Stock Pi, PorcuPi instance

**Stock Pi**:
An independently installed Pi distribution owned by another installer or package manager.
_Avoid_: Fallback Pi, unmanaged Pi
