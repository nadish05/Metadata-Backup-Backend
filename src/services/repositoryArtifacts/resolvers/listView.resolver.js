function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function basenameWithoutSuffix(filePath, suffix) {
    const normalized = normalizePath(filePath);
    const base = normalized.split('/').pop() || '';

    if (!base.endsWith(suffix)) {
        return null;
    }

    return base.slice(0, -suffix.length);
}

const SUFFIX = '.listView-meta.xml';

const listViewArtifactResolver = {
    id: 'ListViewArtifactResolver',
    metadataTypes: ['ListView'],

    resolve({ name, repoFiles }) {
        if (!name || !name.includes('.') || !Array.isArray(repoFiles)) {
            return null;
        }

        const [objectApiName, listViewApiName] = name.split('.');

        if (!objectApiName || !listViewApiName) {
            return null;
        }

        const expectedFolder = `/objects/${objectApiName}/listViews/`;

        return (
            repoFiles
                .map(normalizePath)
                .find(
                    (repoFile) =>
                        repoFile.endsWith(SUFFIX) &&
                        repoFile.includes(expectedFolder) &&
                        basenameWithoutSuffix(repoFile, SUFFIX) ===
                            listViewApiName
                ) || null
        );
    }
};

module.exports = listViewArtifactResolver;
