class DependencyAnalyzer {

    analyzeApexClass(content) {

        const classNameMatch =
            content.match(
                /class\s+([A-Za-z0-9_]+)/
            );

        const currentClass =

            classNameMatch
                ? classNameMatch[1]
                : null;
                
        const innerClassMatches =
    [...content.matchAll(
        /(private|public|global|protected)?\s*class\s+([A-Za-z0-9_]+)/g
    )];

const innerClasses =

    innerClassMatches.map(
        match => match[2]
    );
    



        return this.createEmptyResult();
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