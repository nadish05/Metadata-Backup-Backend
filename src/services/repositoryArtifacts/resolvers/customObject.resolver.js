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

const SUFFIX = '.object-meta.xml';

const customObjectArtifactResolver = {
    id: 'CustomObjectArtifactResolver',
    metadataTypes: ['CustomObject'],

    resolve({ name, repoFiles }) {
        if (!name || !Array.isArray(repoFiles)) {
            return null;
        }

        const marker = `/objects/${name}/`;

        return (
            repoFiles
                .map(normalizePath)
                .find((repoFile) => {
                    if (!repoFile.endsWith(SUFFIX)) {
                        return false;
                    }

                    const baseName = basenameWithoutSuffix(repoFile, SUFFIX);

                    return (
                        baseName === name || repoFile.includes(marker)
                    );
                }) || null
        );
    }
};

module.exports = customObjectArtifactResolver;
