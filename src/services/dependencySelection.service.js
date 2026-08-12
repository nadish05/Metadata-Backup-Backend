function createRequiredDependency(name, type) {
    return {
        name,
        type,
        required: true,
        selected: true,
        editable: false
    };
}

function createRecommendedTestClass(testClass) {
    return {
        name: testClass.name,
        path: testClass.path,
        recommended: true,
        selected: true,
        editable: true
    };
}

function buildDependencySelection(rawAnalysis, testValidation) {
    const requiredDependencies = [
        ...rawAnalysis.apexClasses.map((name) =>
            createRequiredDependency(name, 'ApexClass')
        ),
        ...rawAnalysis.customObjects.map((name) =>
            createRequiredDependency(name, 'CustomObject')
        ),
        ...rawAnalysis.customFields.map((name) =>
            createRequiredDependency(name, 'CustomField')
        ),
        ...(rawAnalysis.relationshipReferences || []).map((name) =>
            createRequiredDependency(name, 'RelationshipReference')
        ),
        ...rawAnalysis.namedCredentials.map((name) =>
            createRequiredDependency(name, 'NamedCredential')
        ),
        ...rawAnalysis.customMetadata.map((name) =>
            createRequiredDependency(name, 'CustomMetadata')
        ),
        ...rawAnalysis.flows.map((name) =>
            createRequiredDependency(name, 'Flow')
        ),
        ...rawAnalysis.triggers.map((name) =>
            createRequiredDependency(name, 'ApexTrigger')
        ),
        ...rawAnalysis.labels.map((name) =>
            createRequiredDependency(name, 'CustomLabel')
        )
    ];

    requiredDependencies.sort((a, b) => {
        const typeCompare = a.type.localeCompare(b.type);

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return a.name.localeCompare(b.name);
    });

    // TEMP DIAGNOSTIC — APEX DEPENDENCY DEBUG (logging only).
    try {
        const {
            classifyDependency
        } = require('./dependencyResolution/dependencyClassification.service');
        const requiredKeys = new Set(
            requiredDependencies.map((dep) => `${dep.type}:${dep.name}`)
        );
        const debugRows = Array.isArray(rawAnalysis?.apexDependencyDebug)
            ? rawAnalysis.apexDependencyDebug
            : [];

        console.log('========================================');
        console.log('APEX DEPENDENCY DEBUG');
        console.log('========================================');

        for (const row of debugRows) {
            const key = `${row.metadataType}:${row.name}`;

            if (!requiredKeys.has(key)) {
                continue;
            }

            const classification = classifyDependency({
                metadataType: row.metadataType,
                type: row.metadataType,
                metadataName: row.name,
                name: row.name
            });

            console.log(
                JSON.stringify({
                    name: row.name,
                    detectedBy: row.detectedBy,
                    metadataType: row.metadataType,
                    source: row.source || 'ApexAnalyzer',
                    sourceSnippetOrMatch: row.sourceSnippetOrMatch || null,
                    sourceClass: row.sourceClass || null,
                    classification: classification.classification,
                    artifactRequired: classification.artifactRequired
                })
            );
        }

        console.log('========================================');
    } catch (error) {
        console.log('========================================');
        console.log('APEX DEPENDENCY DEBUG');
        console.log('========================================');
        console.log('APEX DEPENDENCY DEBUG logging failed:', error?.message);
        console.log('========================================');
    }

    const recommendedTestClasses = (testValidation?.testClasses || []).map(
        createRecommendedTestClass
    );

    return {
        requiredDependencies,
        recommendedTestClasses,
        optionalDependencies: []
    };
}

module.exports = {
    buildDependencySelection
};
