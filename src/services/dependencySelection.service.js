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
        ...rawAnalysis.customFields.map((name) => {
            const dependency = createRequiredDependency(name, 'CustomField');

            // TEMPORARY DEBUG — CustomField dependency materialization (Phase 10.4).
            if (name === 'Session__c.Price__c') {
                console.log('==========================================================');
                console.log('SESSION PRICE DISCOVERED');
                console.log('==========================================================');
                console.log('Full dependency object');
                console.log(JSON.stringify(dependency, null, 2));
                console.log('Exact source line');
                console.log(
                    '(materialized in buildDependencySelection from analyzer customFields list)'
                );
                console.log('Exact parser method');
                console.log('buildDependencySelection → createRequiredDependency(CustomField)');
                console.log('Call stack (top few frames)');
                console.log(
                    (new Error().stack || '')
                        .split('\n')
                        .slice(1, 7)
                        .map((line) => line.trim())
                        .join('\n') || 'n/a'
                );
                console.log('==========================================================');
            }

            console.log('==========================================================');
            console.log('APEX FIELD DISCOVERED');
            console.log('==========================================================');
            console.log('Apex Class:');
            console.log('(see upstream analyzeApexContent / classifyCustomObjectsAndFields)');
            console.log('Field:');
            console.log(name);
            console.log('Object:');
            console.log(name.includes('.') ? name.split('.')[0] : 'n/a');
            console.log('Parser:');
            console.log('dependencySelection (DTO materialization)');
            console.log('Method:');
            console.log('buildDependencySelection');
            console.log('Reason:');
            console.log(
                'CustomField from Apex analyzer rawAnalysis.customFields → requiredDependencies'
            );
            console.log('Source code snippet (around the matched line)');
            console.log('(snippet logged at classifyCustomObjectsAndFields / extractSoqlQualifiedFields)');
            console.log('==========================================================');

            return dependency;
        }),
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
