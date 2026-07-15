function extractExternalCredentialNames(content) {
    if (!content) {
        return [];
    }

    const matches = content.matchAll(
        /<externalCredential>\s*([^<]+?)\s*<\/externalCredential>/gi
    );

    const names = [];

    for (const match of matches) {
        const name = String(match[1] || '').trim();

        if (name) {
            names.push(name);
        }
    }

    return [...new Set(names)];
}

function analyzeNamedCredentialContent(content) {
    const externalCredentialNames = extractExternalCredentialNames(content);

    const requiredDependencies = externalCredentialNames.map((name) => ({
        name,
        type: 'ExternalCredential',
        required: true,
        selected: true,
        editable: false
    }));

    return {
        dependencyAnalysis: {
            requiredDependencies,
            recommendedTestClasses: [],
            optionalDependencies: []
        }
    };
}

module.exports = {
    analyzeNamedCredentialContent,
    extractExternalCredentialNames
};
