class DependencyAnalyzer {

    analyzeApexClass(content) {
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