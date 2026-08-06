const RETRIEVAL_METADATA_PATH =
    '.metadata-backup/retrieval-metadata.json';

async function readRepositorySnapshotMetadata({ readFile = null } = {}) {
    if (typeof readFile !== 'function') {
        return null;
    }

    try {
        const content = await readFile(RETRIEVAL_METADATA_PATH);
        const parsed = JSON.parse(content);

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }

        return {
            snapshotVersion: parsed.snapshotVersion ?? null,
            sourceOrgId: parsed.sourceOrgId || null,
            sourceMetadataApiVersion:
                parsed.sourceMetadataApiVersion || null,
            retrievedAt: parsed.retrievedAt || null
        };
    } catch (error) {
        return null;
    }
}

module.exports = {
    RETRIEVAL_METADATA_PATH,
    readRepositorySnapshotMetadata
};
