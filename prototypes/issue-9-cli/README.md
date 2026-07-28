# PROTOTYPE — PorcuPi v1 command surface

**Question:** Is one guided `porcupi add` flow, one unified `porcupi manage` flow, and an explicit previewing `porcupi apply` the smallest understandable interface for Pi package resource selection and one-level Managed Pi rollback? The prototype also checks whether an install-time `pi` ownership prompt, reversible `porcupi pi enable|disable`, and deletion-only uninstall behavior feel coherent across the required v1 walkthrough.

This is throwaway, in-memory logic for GitHub issue #9. It performs no Git, Pi package, build, launcher, or filesystem operations. The fixture Sources and build failures exist only to exercise the proposed interface. Fixtures include `https://github.com/mattpocock/skills` at exact commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c` and the 20 active Patches in `https://github.com/taylorrowser/pi-wait-for-user` at pinned reference commit `1a987bca79a4f9475dd2037c18b2d6d7b7f68f25`. Node.js is used because PorcuPi's Pi and `pi-wait-for-user` references use the Node ecosystem; the repository does not yet have a task runner.

The accepted v1 Patch discovery convention recursively lists regular `*.patch` files beneath a Source Repository's root `patches/` directory. The existing `pi-wait-for-user/patches/active/` layout already conforms and does not need to move. Each file's source-relative path remains its structural Artifact identity.

An optional root `porcupi.json` may overlay convention-discovered Patches with a display name, description, and exact supported Pi Base versions/commits. Declared incompatibility prevents selection; missing metadata leaves the fixed Patch build as the authority. v1 metadata cannot declare dependencies, hooks, scripts, build recipes, or compatibility-solving behavior. The `extras` fixture demonstrates supported and unsupported Patch metadata.

Run from the repository root:

```sh
node prototypes/issue-9-cli/prototype.mjs
```

Suggested walkthrough:

1. Install, first preserving Stock Pi.
2. Type either shortcut `a` or a proposed full command such as `porcupi add https://github.com/mattpocock/skills`. The three-page wizard covers Artifact selection, global/project scope, and final review. Use arrows or `hjkl` to navigate, Space/Enter to select, `a`/`d` to select/deselect all Artifacts, and `n`, Right, or `l` to advance. Select real pinned Patch fixtures with `porcupi add https://github.com/taylorrowser/pi-wait-for-user` (or fixture alias `wait`).
3. Run `porcupi manage` to remove current selections or change retained resource scopes, then review/save. Patch changes remain pending until apply.
4. Toggle the next build to fail, then apply and confirm that activation is unchanged.
5. Toggle back to success, apply, launch, and verify.
6. Roll back and inspect active/previous composition state.
7. Enable and disable `pi` ownership.
8. Uninstall and confirm Pi package resource selections remain while PorcuPi-owned state is removed.

Proposed public surface under test:

```text
<bootstrap installer>                    # asks whether to own `pi`; defaults to no
porcupi                                  # launch active Managed Pi
porcupi add [git-source]                 # inspect exact commit and add Artifact selections
porcupi manage                           # remove selections or change resource scopes
porcupi apply                            # preview ordered Patches, confirm, build, activate
porcupi verify                           # fully verify active Managed Pi
porcupi rollback                         # switch to the one retained previous composition
porcupi pi enable | disable              # reversibly control `pi` ownership
porcupi uninstall                        # remove only PorcuPi-owned state
```
