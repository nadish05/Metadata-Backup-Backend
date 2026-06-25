class DependencyAnalyzer {

    analyzeApexClass(content) {

    const result =
        this.createEmptyResult();

    const namedCredentialMatches =
        content.match(
            /callout:([A-Za-z0-9_]+)/g
        ) || [];

    result.namedCredentials =
        [...new Set(

            namedCredentialMatches.map(
                item =>
                    item.replace(
                        'callout:',
                        ''
                    )
            )

        )];

    return result;

}

    analyzeTrigger(content) {
        return this.createEmptyResult();
    }

    analyzeFlow(content) {
        return this.createEmptyResult();
    }

    analyzeLWC(content) {
        return this.createEmptyResult();
    }

    analyzeCustomObject(content) {
        return this.createEmptyResult();
    }

    createEmptyResult() {

        return {

            customObjects: [],
            customFields: [],
            apexClasses: [],
            triggers: [],
            flows: [],
            customMetadata: [],
            namedCredentials: [],
            labels: [],
            permissionSets: [],
            layouts: [],
            recordTypes: [],
            validationRules: [],
            pageLayouts: []

        };

    }

}

module.exports = new DependencyAnalyzer();