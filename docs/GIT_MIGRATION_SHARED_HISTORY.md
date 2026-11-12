# Shared Git migration (`history/anchor`)

## Operator bootstrap (manual only)

The application **never** creates or updates `history/anchor`.

1. On `https://github.com/nadish05/New-salesforce-Backup`, create branch `history/anchor` with a minimal scaffold commit (README + optional `.gitattributes`).
2. Do **not** modify `main`, `Gym`, or `Agent` during Phase 1 rollout.
3. Record the anchor SHA for verification: `git rev-parse origin/history/anchor`.

## Feature flag

| Variable | Default | Effect |
|----------|---------|--------|
| `GIT_MIGRATION_SHARED_HISTORY` | unset / `false` | Legacy `git init` + force-push (guarded) |
| `GIT_MIGRATION_SHARED_HISTORY=true` | — | Shared-history clone, tree sync, CAS non-force push |

## Branch policies

| Situation | Legacy (`false`) | Shared (`true`) |
|-----------|------------------|-----------------|
| New branch name (anchor exists) | **`GIT_MIGRATION_SHARED_REQUIRED`** | Create from anchor |
| Existing unrelated branch (e.g. Gym) | Force-push allowed | **`GIT_MIGRATION_BRANCH_HISTORY_INCOMPATIBLE`** |
| Existing descendant of anchor | **`GIT_MIGRATION_LEGACY_BLOCKED`** | Update with new commit |
| Anchor missing/invalid | **No publish** (fail closed) | **No publish** |

## `retrieveAllMetadata`

When `GIT_MIGRATION_SHARED_HISTORY=true`, retrieval and JSON response are unchanged; **all Git steps are skipped** ( `main` is not published).

When flag is `false`, legacy `main` force-push remains subject to the legacy guard.

## Rollback

Set `GIT_MIGRATION_SHARED_HISTORY=false` to return new migrates to legacy path. Shared-history branches already on GitHub are protected from legacy force-push when they descend from the anchor.

Do not run legacy migration against shared-history branches.
