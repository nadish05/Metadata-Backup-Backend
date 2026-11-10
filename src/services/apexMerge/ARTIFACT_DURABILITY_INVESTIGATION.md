# Artifact durability — approved direction

## Superseded: GitHub immutable ref strategy

The GitHub orphan-commit / `refs/apex-merge/*` approach described in early investigations is **superseded** and **must not** be implemented. GitHub remains the metadata **source and comparison** repository only; it is not approved storage for sealed merge artifacts.

Constraints:

- No GitHub artifact branches, commits, or refs for merge bytes.
- No external databases, object storage, or durable backend filesystem for merge artifacts.
- Salesforce Application Org is the **only** persistent product storage.

## Approved architecture

| Phase | Layer | Responsibility |
|-------|--------|----------------|
| **1.6a** (implemented) | Backend session (in-memory) | Seal assigns `artifactId` per `.cls` / `.cls-meta.xml`; binary `GET` with SHA-256 verification during TTL |
| **1.6b** (planned) | Salesforce Apex | Immediately after seal: binary GET → verify hash → `ContentVersion` on `Deployment_Plan__c`; manifest JSON holds refs + hashes |
| **Phase 2** (later) | Backend validate | Load bytes from `deploymentPackage` (injected by Apex from Files); `verifyManifestUnitHashes` |

Flow:

```
Merge wizard → seal (manifest + artifactIds)
    → Apex callouts GET each artifact (correlation query params)
    → SHA-256 verify in Apex
    → ContentVersion (Salesforce Files)
    → Deployment_Plan__c manifest JSON (hashes + contentDocumentId / artifactId)
```

Pattern mirrors existing **snapshot export** (`snapshotExport` metadata + `/api/deployment/snapshot-artifact` binary GET + `SnapshotPersistenceService`), but merge handoff uses `/api/merge/apex/sessions/.../artifacts/...` and persists to the deployment plan instead of rollback snapshot members.

## Phase 1.6a scope (backend)

- `units[].artifacts.*.artifactId` in sealed manifest
- `GET /api/merge/apex/sessions/:id/artifacts/:artifactId`
- Mandatory correlation query: `comparisonId`, `deploymentPlanId`, `mergeManifestId`
- No Salesforce Files persistence in 1.6a

## Remaining risks

- If Apex does not complete handoff before sealed session TTL (~1h), bytes are lost and merge must be repeated.
- Correlation IDs are not a substitute for network-layer auth; restrict backend merge URL exposure consistent with existing deployment API practices.
