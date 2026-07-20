function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

const lightningComponentBundleArtifactResolver = {
    id: 'LightningComponentBundleArtifactResolver',
    metadataTypes: ['LightningComponentBundle'],

    /**
     * Resolves to the bundle directory path (…/lwc/<name>).
     * Workspace expands member files from that directory.
     */
    resolve({ name, repoFiles }) {
        if (!name || !Array.isArray(repoFiles)) {
            return null;
        }

        const marker = `/lwc/${name}/`;
        const match = repoFiles
            .map(normalizePath)
            .find((repoFile) => repoFile.includes(marker));

        if (!match) {
            return null;
        }

        const markerIndex = match.indexOf(marker);

        return match.slice(0, markerIndex + marker.length - 1);
    }
};

module.exports = lightningComponentBundleArtifactResolver;
