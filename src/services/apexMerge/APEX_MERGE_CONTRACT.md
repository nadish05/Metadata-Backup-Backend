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
| `artifacts.cls` | yes | `{ artifactId, sha256, byteLength }` |
| `artifacts.metaXml` | yes | `{ artifactId, sha256, byteLength }` |

### Artifact ID format (Phase 1.6a)

Generated once at seal and stored in the manifest:

`{mergeManifestId}_{metadataName}_{role}`

| Part | Example |
|------|---------|
| `mergeManifestId` | `manifest_550e8400-e29b-41d4-a716-446655440000` |
| `metadataName` | Sanitized `[A-Za-z0-9_]` only (invalid chars → `_`) |
| `role` | `cls` or `metaXml` |

Example: `manifest_550e8400-e29b-41d4-a716-446655440000_AccountService_cls`

IDs are unique within a manifest (one `mergeManifestId` per seal). They do not embed paths, credentials, or secrets.

Artifact **content is not** in the manifest (hashes + IDs only). Bytes remain in the in-memory sealed session until TTL for binary handoff.

## Artifact handoff — `GET /apex/sessions/:id/artifacts/:artifactId` (Phase 1.6a)

Salesforce Application Org retrieves approved bytes before session expiry (Phase 1.6b persists to `ContentVersion`).

### Request

| Param | Location | Required |
|-------|----------|----------|
| `mergeSessionId` | path `:id` | yes |
| `artifactId` | path | yes |
| `comparisonId` | query | yes |
| `deploymentPlanId` | query | yes |
| `mergeManifestId` | query | yes |

Example:

`GET /api/merge/apex/sessions/merge_<uuid>/artifacts/manifest_<uuid>_Demo_cls?comparisonId=...&deploymentPlanId=...&mergeManifestId=manifest_<uuid>`

### Success `200`

| Header | Value |
|--------|--------|
| `Content-Type` | `application/octet-stream` |
| `Cache-Control` | `no-store` |
| `Content-Length` | byte length (UTF-8) |

Body: raw UTF-8 artifact bytes (no JSON wrapper).

### Integrity (server-side before response)

1. Session must be `SEALED` with manifest present.
2. Correlation: `comparisonId`, `deploymentPlanId`, `mergeManifestId` match sealed manifest.
3. `artifactId` registered under `manifest.units[]`.
4. Content read from session unit (not Git re-merge).
5. SHA-256 and `byteLength` must match manifest descriptor — else `HASH_MISMATCH`.

### Error envelope

Same JSON shape as other merge routes: `{ success: false, code, error, details }`.

| Code | HTTP | When |
|------|------|------|
| `SESSION_NOT_FOUND` | 404 | Unknown session |
| `SESSION_EXPIRED` | 410 | Sealed/open TTL exceeded |
| `SESSION_NOT_SEALED` | 409 | Session not sealed |
| `ARTIFACT_NOT_FOUND` | 404 | ID not in manifest / unit missing |
| `CORRELATION_MISMATCH` | 409 | Query IDs ≠ manifest |
| `HASH_MISMATCH` | 400 | Bytes ≠ sealed hash/length |
| `INVALID_REQUEST` | 400 | Missing query params or bad `artifactId` format |

### Expiration

- Sealed sessions: ~**1 hour** after `sealedAt` (configurable in store for tests).
- Open sessions: ~**6 hours** from `createdAt`.
- After expiry, artifact GET fails; user must repeat merge. **No backend durable artifact store.**

### Security assumptions

Merge routes have **no separate authentication layer** beyond correlation query parameters and session/manifest binding. Knowing `mergeSessionId`, `mergeManifestId`, and plan/comparison IDs is treated as sufficient to fetch bytes during the handoff window — same trust model as existing merge APIs. Apex proxy in the Application Org should perform handoff immediately after seal; LWC must not receive merge artifact bodies or OAuth tokens.
