# Issue tracker: GitHub

Issues and planning maps for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, also fetching labels.
- **List issues**: use `gh issue list` with the narrowest suitable state and label filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Claim an issue**: `gh issue edit <number> --add-assignee @me`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Wayfinding operations

- **Map**: an issue labelled `wayfinder:map`.
- **Child ticket**: a GitHub sub-issue, falling back to a task-list entry only if native sub-issues are unavailable.
- **Blocking**: GitHub native issue dependencies, falling back to a `Blocked by:` line only if native dependencies are unavailable.
- **Frontier query**: find the first open, unblocked, and unassigned child.
- **Claim**: assign the ticket to `@me` before doing any work.
- **Resolve**: post the answer as a resolution comment, close the ticket, and append a linked one-line gist to the map's Decisions so far.
