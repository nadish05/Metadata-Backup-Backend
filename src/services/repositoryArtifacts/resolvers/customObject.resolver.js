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
        // DEBUG ONLY — temporary diagnostics for artifact resolution.
        const expectedFolder = name ? `objects/${name}/` : '(unknown)';
        const expectedFile = name
            ? `${name}.object-meta.xml`
            : '(unknown)';

        console.log('Expected object folder:');
        console.log(expectedFolder);
        console.log('Expected object file:');
        console.log(expectedFile);
        console.log('Expected Folder:');
        console.log(expectedFolder);
        console.log('Expected File:');
        console.log(expectedFile);

        if (!Array.isArray(repoFiles)) {
            console.log('Repository Matches:');
            console.log('(no matches)');
            console.log('Resolver failed because:');
            console.log('Repository index empty');
            console.log('Resolved: false');
            console.log('Resolved Path:');
            console.log(null);
            return null;
        }

        if (repoFiles.length === 0) {
            console.log('Repository Matches:');
            console.log('(no matches)');
            console.log('Resolver failed because:');
            console.log('Repository index empty');
            console.log('Resolved: false');
            console.log('Resolved Path:');
            console.log(null);
            return null;
        }

        if (!name) {
            console.log('Repository Matches:');
            console.log('(no matches)');
            console.log('Resolver failed because:');
            console.log('Metadata name mismatch');
            console.log('Resolved: false');
            console.log('Resolved Path:');
            console.log(null);
            return null;
        }

        const normalizedFiles = repoFiles.map(normalizePath);
        const nameMatches = normalizedFiles.filter((repoFile) =>
            repoFile.includes(name)
        );

        console.log('Repository Matches:');
        if (nameMatches.length) {
            for (const match of nameMatches) {
                console.log(match);
            }
        } else {
            console.log('(no matches)');
        }

        const marker = `/objects/${name}/`;
        const folderMatches = normalizedFiles.filter((repoFile) =>
            repoFile.includes(marker)
        );
        const objectMetaCandidates = normalizedFiles.filter((repoFile) =>
            repoFile.endsWith(SUFFIX)
        );

        const resolvedPath =
            normalizedFiles.find((repoFile) => {
                if (!repoFile.endsWith(SUFFIX)) {
                    return false;
                }

                const baseName = basenameWithoutSuffix(repoFile, SUFFIX);

                return baseName === name || repoFile.includes(marker);
            }) || null;

        if (resolvedPath) {
            console.log('Resolved: true');
            console.log('Resolved Path:');
            console.log(resolvedPath);
            return resolvedPath;
        }

        console.log('Resolved: false');
        console.log('Resolved Path:');
        console.log(null);
        console.log('Resolver failed because:');

        if (!folderMatches.length) {
            console.log('No matching object folder found');
        } else if (
            !objectMetaCandidates.some(
                (repoFile) =>
                    basenameWithoutSuffix(repoFile, SUFFIX) === name ||
                    repoFile.includes(marker)
            )
        ) {
            console.log('No object-meta.xml found');
        } else {
            console.log('Metadata name mismatch');
        }

        return null;
    }
};

module.exports = customObjectArtifactResolver;
