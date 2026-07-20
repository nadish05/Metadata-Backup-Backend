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

const SUFFIX = '.field-meta.xml';

const customFieldArtifactResolver = {
    id: 'CustomFieldArtifactResolver',
    metadataTypes: ['CustomField'],

    resolve({ name, repoFiles }) {
        if (!name || !name.includes('.') || !Array.isArray(repoFiles)) {
            return null;
        }

        const [objectName, fieldName] = name.split('.');

        if (!objectName || !fieldName) {
            return null;
        }

        const expectedFolder = `/objects/${objectName}/fields/`;

        return (
            repoFiles
                .map(normalizePath)
                .find(
                    (repoFile) =>
                        repoFile.endsWith(SUFFIX) &&
                        repoFile.includes(expectedFolder) &&
                        basenameWithoutSuffix(repoFile, SUFFIX) === fieldName
                ) || null
        );
    }
};

module.exports = customFieldArtifactResolver;
