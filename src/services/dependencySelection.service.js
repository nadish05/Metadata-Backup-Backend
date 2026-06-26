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
