# Artifact durability investigation (Git immutable ref strategy)

**Status:** Investigation only — **not implemented** in Phase 1.5.

## Problem

Sealed `apexMergeManifest.units[]` stores **SHA-256 + byteLength** only. Resolved bytes live in the in-memory session (`mergeSession.store.js`). After restart or TTL, Phase 2 cannot reconstruct user-resolved content from hashes alone unless Git re-merge reproduces identical bytes.

## Proposed pattern

1. On seal, write merged `.cls` and `.cls-meta.xml` to a dedicated path, e.g.  
   `apex-merge-artifacts/{mergeManifestId}/force-app/.../ClassName.cls`
2. Create an **orphan commit** (or commit on a dedicated ref such as `refs/apex-merge/manifest-{id}`) without updating `source` or `destination` branches.
3. Manifest gains: `artifactGitRef`, `artifactCommitSha`, per-unit `artifactPaths[]`.
4. At validate/deploy, `git show <commitSha>:path` → verify SHA-256 → write workspace.

## Existing backend GitHub integration

| Capability | Finding |
|------------|---------|
| Token | `GITHUB_TOKEN` env; injected into HTTPS clone URLs (`apexMergeGit.service.js`, `deploymentWorkspace.service.js`, compare/deployment controllers). |
| API routes | `/api/github/*` — clone/migrate/status only; **no** Contents API or ref-creation helper today. |
| Merge sessions | Ephemeral `git clone` + `fetch --all` to temp dir; no push. |
| Permissions needed (proposed) | `contents:write` (create blobs/trees/commits), `contents:read`, ability to create/update **refs** (not branch tips used for Agent/Gym). Fine-grained or PAT scoped to one repo. |

## Design considerations

| Topic | Notes |
|-------|-------|
| Atomicity | Seal should fail if artifact push fails; do not return manifest without a verified `artifactCommitSha`. |
| Concurrent sessions | Use unique `mergeManifestId` paths; no shared ref per session. |
| Partial upload | Multi-file commit in one Git tree; rollback ref creation if commit fails. |
| Retention | Orphan commits accumulate; policy needed (GC via GitHub API or scheduled prune of `refs/apex-merge/*` older than N days). |
| Backend restart | **Durable** if manifest + commit SHA live on Salesforce plan JSON and GitHub ref survives TTL. Session memory is not required. |
| Branch safety | Never fast-forward `source`/`destination`; only `refs/apex-merge/...` or orphan commits. |
| Re-merge fallback | Still verify SHA-256 after fetch; hash mismatch → block deploy. |

## Recommended implementation (post-approval)

1. `apexMergeArtifactGit.service.js` — create tree, commit, update ref via GitHub REST (use same token plumbing).
2. Extend `buildApexMergeManifest` with optional `artifactStore` block after successful push.
3. Change `applyApexMergeFromManifest` (Phase 2) to prefer `git show artifactCommitSha:path` over pure re-merge when present.
4. Keep Salesforce `Apex_Merge_Manifest_JSON__c` as transport; size limit may require storing only `artifactCommitSha` + manifest id if bytes are on GitHub.

## Risks if not implemented before Phase 2

- Conflict resolutions (`ACCEPT_*`) and any merge outcome that differs from a fresh `git merge-file` will fail hash verification when the session has expired.
- Hash-only manifest + Git re-merge is sufficient only for **automatic** clean merges within pinned SHAs.
