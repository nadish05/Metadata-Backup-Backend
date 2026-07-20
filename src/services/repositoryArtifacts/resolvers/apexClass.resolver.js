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

const SUFFIX = '.cls';

const apexClassArtifactResolver = {
    id: 'ApexClassArtifactResolver',
    metadataTypes: ['ApexClass'],

    resolve({ name, repoFiles }) {
        if (!name || !Array.isArray(repoFiles)) {
            return null;
        }

        return (
            repoFiles
                .map(normalizePath)
                .find(
                    (repoFile) =>
                        repoFile.endsWith(SUFFIX) &&
                        basenameWithoutSuffix(repoFile, SUFFIX) === name
                ) || null
        );
    }
};

module.exports = apexClassArtifactResolver;
