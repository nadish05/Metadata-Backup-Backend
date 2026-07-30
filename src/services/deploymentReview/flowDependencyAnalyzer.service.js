/**
 * Flow dependency analyzer — Phase 2.
 *
 * Parses Flow .flow-meta.xml and extracts metadata references for Deployment Review.
 * Discovery only — does not validate existence, destination state, or deployability.
 */

function createRequiredDependency(name, type) {
    return {
        name,
        type,
        required: true,
        selected: true,
        editable: false
    };
}

function uniqueSorted(values) {
    return [...new Set((values || []).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
    );
}

function extractFirstTagValue(block, tagName) {
    if (!block || !tagName) {
        return null;
    }

    const match = String(block).match(
        new RegExp(`<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`, 'i')
    );

    if (!match) {
        return null;
    }

    const value = String(match[1] || '').trim();
    return value || null;
}

function extractAllTagValues(content, tagName) {
    if (!content || !tagName) {
        return [];
    }

    const values = [];
    const matches = String(content).matchAll(
        new RegExp(`<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`, 'gi')
    );

    for (const match of matches) {
        const value = String(match[1] || '').trim();

        if (value) {
            values.push(value);
        }
    }

    return values;
}

function extractBlocks(content, tagName) {
    if (!content || !tagName) {
        return [];
    }

    return String(content).match(
        new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`, 'gi')
    ) || [];
}

function isCustomObjectApiName(name) {
    return typeof name === 'string' && /__c$/i.test(name);
}

function isCustomFieldApiName(name) {
    return typeof name === 'string' && /__c$/i.test(name) && !name.includes('.');
}

function extractSubflowNames(content) {
    return uniqueSorted(extractAllTagValues(content, 'flowName'));
}

function extractApexClassNames(content) {
    const names = [...extractAllTagValues(content, 'apexClass')];

    for (const block of extractBlocks(content, 'actionCalls')) {
        const actionType = extractFirstTagValue(block, 'actionType');
        const actionName = extractFirstTagValue(block, 'actionName');

        if (!actionName || !actionType) {
            continue;
        }

        // Invocable Apex actions are stored as actionType=apex.
        if (String(actionType).toLowerCase() === 'apex') {
            names.push(actionName);
        }
    }

    return uniqueSorted(names);
}

function extractEmailAlertNames(content) {
    const names = [];

    for (const block of extractBlocks(content, 'actionCalls')) {
        const actionType = extractFirstTagValue(block, 'actionType');
        const actionName = extractFirstTagValue(block, 'actionName');

        if (!actionName || !actionType) {
            continue;
        }

        if (String(actionType).toLowerCase() === 'emailalert') {
            names.push(actionName);
        }
    }

    return uniqueSorted(names);
}

function collectCustomObjectsFromTags(content) {
    const names = [
        ...extractAllTagValues(content, 'object'),
        ...extractAllTagValues(content, 'objectType')
    ];

    for (const block of extractBlocks(content, 'dataTypeMappings')) {
        const typeValue = extractFirstTagValue(block, 'typeValue');

        if (typeValue) {
            names.push(typeValue);
        }
    }

    return uniqueSorted(names.filter(isCustomObjectApiName));
}

function extractCustomFieldsFromRecordBlocks(content) {
    const recordTags = [
        'recordCreates',
        'recordUpdates',
        'recordLookups',
        'recordDeletes'
    ];
    const fields = [];

    for (const tagName of recordTags) {
        for (const block of extractBlocks(content, tagName)) {
            const objectApiName = extractFirstTagValue(block, 'object');

            if (!isCustomObjectApiName(objectApiName)) {
                continue;
            }

            for (const fieldApiName of extractAllTagValues(block, 'field')) {
                if (!isCustomFieldApiName(fieldApiName)) {
                    continue;
                }

                fields.push(`${objectApiName}.${fieldApiName}`);
            }
        }
    }

    return uniqueSorted(fields);
}

function extractCustomFieldsFromStartRecordReferences(content) {
    const startBlocks = extractBlocks(content, 'start');
    const fields = [];

    for (const startBlock of startBlocks) {
        const objectApiName = extractFirstTagValue(startBlock, 'object');

        if (!isCustomObjectApiName(objectApiName)) {
            continue;
        }

        const references = String(content).matchAll(
            /\$Record\.([A-Za-z][A-Za-z0-9_]*)/g
        );

        for (const match of references) {
            const fieldApiName = match[1];

            if (isCustomFieldApiName(fieldApiName)) {
                fields.push(`${objectApiName}.${fieldApiName}`);
            }
        }
    }

    return uniqueSorted(fields);
}

function extractRecordTypeNames(content) {
    const recordTags = [
        'recordCreates',
        'recordUpdates',
        'recordLookups',
        'recordDeletes',
        'start'
    ];
    const names = [];

    for (const tagName of recordTags) {
        for (const block of extractBlocks(content, tagName)) {
            const objectApiName = extractFirstTagValue(block, 'object');

            if (!objectApiName) {
                continue;
            }

            const filterBlocks = extractBlocks(block, 'filters');

            for (const filterBlock of filterBlocks) {
                const field = extractFirstTagValue(filterBlock, 'field');
                const stringValue = extractFirstTagValue(
                    filterBlock,
                    'stringValue'
                );

                if (
                    !stringValue ||
                    !field ||
                    !/RecordType\.DeveloperName$/i.test(field)
                ) {
                    continue;
                }

                names.push(`${objectApiName}.${stringValue}`);
            }
        }
    }

    return uniqueSorted(names);
}

/**
 * Analyze Flow XML and return Deployment Review dependencyAnalysis shape.
 *
 * @param {string} content
 * @returns {{
 *   requiredDependencies: Array<object>,
 *   recommendedTestClasses: Array,
 *   optionalDependencies: Array,
 *   analysisStatus: string
 * }}
 */
function analyzeFlowDependencies(content) {
    const flows = extractSubflowNames(content);
    const apexClasses = extractApexClassNames(content);
    const emailAlerts = extractEmailAlertNames(content);
    const customObjects = collectCustomObjectsFromTags(content);
    const customFields = uniqueSorted([
        ...extractCustomFieldsFromRecordBlocks(content),
        ...extractCustomFieldsFromStartRecordReferences(content)
    ]);
    const recordTypes = extractRecordTypeNames(content);

    const requiredDependencies = [
        ...flows.map((name) => createRequiredDependency(name, 'Flow')),
        ...apexClasses.map((name) =>
            createRequiredDependency(name, 'ApexClass')
        ),
        ...customObjects.map((name) =>
            createRequiredDependency(name, 'CustomObject')
        ),
        ...customFields.map((name) =>
            createRequiredDependency(name, 'CustomField')
        ),
        ...emailAlerts.map((name) =>
            createRequiredDependency(name, 'EmailAlert')
        ),
        ...recordTypes.map((name) =>
            createRequiredDependency(name, 'RecordType')
        )
    ];

    requiredDependencies.sort((a, b) => {
        const typeCompare = a.type.localeCompare(b.type);

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return a.name.localeCompare(b.name);
    });

    return {
        requiredDependencies,
        recommendedTestClasses: [],
        optionalDependencies: [],
        analysisStatus: 'ANALYZED'
    };
}

module.exports = {
    analyzeFlowDependencies,
    extractSubflowNames,
    extractApexClassNames,
    extractEmailAlertNames,
    collectCustomObjectsFromTags,
    extractCustomFieldsFromRecordBlocks,
    extractRecordTypeNames,
    createRequiredDependency
};
