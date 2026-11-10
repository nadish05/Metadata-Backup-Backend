# Apex Merge API contract (Phase 1.5)

Base path: `/api/merge/apex/sessions`

## Authentication (preview drift)

Destination drift checks require live org retrieve. **Preview** requests must include:

| Field | Required | Source |
|-------|----------|--------|
| `refreshToken` | yes | Destination `Connected_Org__c.Refresh_Token__c` (Salesforce Apex proxy only — never LWC) |
| `instanceUrl` | yes | Destination `Connected_Org__c.Instance_URL__c` |

Tokens must not be logged. No merge-specific OAuth flow; reuse existing connected-org storage.

## Create — `POST /apex/sessions`

### Request

| Field | Required |
|-------|----------|
| `repoUrl` | yes |
| `sourceBranch` | yes |
| `destinationBranch` | yes |
| `comparisonId` | yes |
| `deploymentPlanId` | yes |
| `classes` **or** `eligibleClasses` | yes (≥1) |

Each class row:

| Field | Required | Notes |
|-------|----------|-------|
| `metadataType` | optional | Must be `ApexClass` if set |
| `metadataName` | yes* | *Or derivable from `filePath` / `classFilePath` |
| `filePath` | optional | Canonical repo-relative `.cls` path |
| `classFilePath` | optional | Alias of `filePath` |

Duplicate `metadataName` with conflicting paths → `DUPLICATE_CLASS_IDENTITY`.

### Response `201`

`success`, `mergeSessionId`, `status` (`OPEN`), `gitPins`, `comparisonId`, `deploymentPlanId`, `classes[]` with `{ metadataName, filePath }`.

## Preview — `POST /apex/sessions/:id/preview`

### Request

| Field | Required |
|-------|----------|
| `refreshToken` | yes |
| `instanceUrl` | yes |
| `metadataName` | optional | When set, adds per-class focus fields (below) |
| `comparisonId` | optional | Correlation |
| `deploymentPlanId` | optional | Correlation |

Drift check runs for **every** class in the session (mandatory).

### Response `200` (canonical)

Always includes:

```json
{
  "success": true,
  "mergeSessionId": "...",
  "status": "PREVIEWED",
  "comparisonId": "...",
  "deploymentPlanId": "...",
  "classes": [ /* see class entry */ ]
}
```

**Class entry** (source of truth):

| Field | Description |
|-------|-------------|
| `metadataName`, `filePath`, `metaXmlPath`, `mergeBaseSha` | Identity |
| `conflictState` | `NONE` \| `UNRESOLVED` |
| `drift` | `{ status: "MATCH", orgHash, gitHash, destinationHeadSha }` |
| `hasConflicts` | boolean |
| `conflicts` | `[{ id, artifact, message }]` |
| `mergedContent` | Full merged `.cls` text |
| `mergedMetaXml` | Full merged `-meta.xml` text |
| `artifacts.cls` / `artifacts.metaXml` | `{ conflict, byteLength }` |
| `preview.cls` / `preview.metaXml` | Same bytes as merged content (stable alias) |

When request includes `metadataName`, the same object is also mirrored at the **top level**:

`metadataName`, `hasConflicts`, `conflicts`, `mergedContent`, `mergedMetaXml`, `mergedPreview`, `conflictState`.

`threeWay` artifacts are **server-only** (not returned).

## Resolve — `POST /apex/sessions/:id/resolve`

### Request (batch)

```json
{
  "resolutions": [
    {
      "metadataName": "Foo",
      "resolutionStrategy": "ACCEPT_SOURCE"
    }
  ]
}
```

### Request (single-class, Salesforce)

```json
{
  "metadataName": "Foo",
  "resolutionStrategy": "ACCEPT_SOURCE"
}
```

Strategies (backend-owned, uses stored three-way blobs from preview):

- `ACCEPT_SOURCE` — source branch `.cls` + `.cls-meta.xml`
- `ACCEPT_TARGET` — destination branch `.cls` + `.cls-meta.xml`

Optional manual override (validated server-side, SHA-256 computed on resolve):

```json
{
  "metadataName": "Foo",
  "resolutions": { "cls": "...", "metaXml": "..." }
}
```

### Response `200`

`success`, `mergeSessionId`, `status` (`RESOLVED`), `classes[]` with `conflictState` and artifact `sha256`.

With `metadataName` in request: top-level `mergedContent`, `hasConflicts`, `conflicts`, etc.

## Seal — `POST /apex/sessions/:id/seal`

Optional `comparisonId`, `deploymentPlanId`.

Response: `apexMergeManifest` (see manifest schema).

## Get — `GET /apex/sessions/:id`

Session summary; `apexMergeManifest` present when sealed.

## Manifest schema (`apexMergeManifest`)

**Canonical collection:** `units[]` only (do not use `classes`, `entries`, or `mergedClasses`).

| Field | Required | Description |
|-------|----------|-------------|
| `schemaVersion` | yes | `1` |
| `mergeManifestId` | yes | `manifest_<uuid>` |
| `mergeSessionId` | yes | |
| `comparisonId` | yes | Correlation |
| `deploymentPlanId` | yes | Correlation |
| `repoUrl` | yes | |
| `sourceBranch` | yes | |
| `destinationBranch` | yes | |
| `gitPins` | yes | `{ sourceHeadSha, destinationHeadSha, recordedAt? }` |
| `sealedAt` | yes | ISO-8601 |

Each **unit**:

| Field | Required |
|-------|----------|
| `metadataType` | yes (`ApexClass`) |
| `metadataName` | yes |
| `filePath` | yes |
| `metaXmlPath` | yes |
| `mergeMode` | yes (`FULL`) |
| `mergeBaseSha` | yes |
| `conflictState` | yes (`NONE` \| `RESOLVED`) |
| `artifacts.cls` | yes | `{ sha256, byteLength }` |
| `artifacts.metaXml` | yes | `{ sha256, byteLength }` |

Artifact **content is not** in the manifest (hashes only). Bytes live in the merge session until TTL; durable storage is a separate Phase 2+ design.
