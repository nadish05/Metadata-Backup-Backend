const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    METADATA_KINDS,
    METADATA_TYPE_RULES,
    getMetadataTypeRule
} = require('../config/metadataTypes');
const {
    buildExistenceQuery,
    usesToolingApi
} = require('./destinationInventory/destinationExistenceQueries');
const {
    validateDependencies
} = require('./dependencyValidation.service');
const {
    classifyDependency,
    CLASSIFICATIONS
} = require('./dependencyResolution/dependencyClassification.service');
const {
    getArtifactResolver
} = require('./repositoryArtifacts/artifactResolverRegistry');
const {
    enrichNode
} = require('./repositoryArtifacts/artifactResolution.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function readControllerSource() {
    return fs.readFileSync(
        path.join(__dirname, '../controllers/metadata.controller.js'),
        'utf8'
    );
}

function extractMetadataTypeArrays(source) {
    const matches = [
        ...source.matchAll(/const metadataTypes = \[([\s\S]*?)\];/g)
    ];

    return matches.map((match) =>
        [...match[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((item) => item[1])
    );
}

async function main() {
    await runTest('CustomTab remains a first-class METADATA_TYPE_RULES entry', () => {
        const rule = getMetadataTypeRule('CustomTab');

        assert.ok(METADATA_TYPE_RULES.CustomTab);
        assert.ok(getMetadataTypeRule('CustomTab'));
        assert.strictEqual(rule.kind, METADATA_KINDS.FILE);
        assert.strictEqual(rule.folder, 'tabs');
        assert.strictEqual(rule.extension, '.tab-meta.xml');
        assert.strictEqual(
            getArtifactResolver('CustomTab').id,
            'GenericFileArtifactResolver'
        );
    });

    await runTest(
        'retrieval type lists include CustomTab for GitHub migration and retrieve-all',
        () => {
            const arrays = extractMetadataTypeArrays(readControllerSource());

            assert.ok(arrays.length >= 2, 'expected both retrieve type lists');
            assert.ok(
                arrays.every((types) => types.includes('CustomTab')),
                `CustomTab missing from retrieval lists: ${JSON.stringify(arrays)}`
            );
            assert.ok(
                arrays[0].includes('PermissionSet'),
                'primary retrieve list regression'
            );
            assert.ok(
                arrays[0].includes('Flow'),
                'primary retrieve list regression'
            );
        }
    );

    await runTest('destination inventory can query CustomTab existence', () => {
        assert.strictEqual(usesToolingApi('CustomTab'), false);
        assert.strictEqual(
            buildExistenceQuery('CustomTab', 'Gym_Trainer__c'),
            "SELECT DurableId, Name FROM TabDefinition WHERE Name = 'Gym_Trainer__c' LIMIT 1"
        );
    });

    await runTest(
        'dependency validation treats CustomTab as a supported packageable type',
        async () => {
            const classification = classifyDependency({
                type: 'CustomTab',
                name: 'Gym_Trainer__c'
            });

            assert.strictEqual(
                classification.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA
            );
            assert.strictEqual(classification.artifactRequired, true);
            assert.strictEqual(classification.packageable, true);

            const packageWithCustomTab = {
                metadata: [
                    {
                        metadataType: 'CustomTab',
                        metadataName: 'Gym_Trainer__c'
                    }
                ],
                dependencies: []
            };

            const exists = await validateDependencies({
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com',
                generatedDeploymentPackage: packageWithCustomTab,
                destinationStates: new Map([
                    ['CustomTab:Gym_Trainer__c', 'EXISTS']
                ])
            });

            assert.strictEqual(exists.overallStatus, 'PASS');
            assert.strictEqual(exists.results[0].type, 'CustomTab');
            assert.strictEqual(exists.results[0].status, 'PASS');
            assert.ok(
                !String(exists.results[0].message || '').includes(
                    'validation is not supported'
                )
            );

            const missingButPackaged = await validateDependencies({
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com',
                generatedDeploymentPackage: packageWithCustomTab,
                destinationStates: new Map([
                    ['CustomTab:Gym_Trainer__c', 'MISSING']
                ])
            });

            assert.strictEqual(missingButPackaged.overallStatus, 'PASS');
            assert.strictEqual(missingButPackaged.results[0].status, 'PASS');
            assert.ok(
                !String(missingButPackaged.results[0].message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest(
        'CustomTab artifact resolution still locates tabs folder source files',
        () => {
            const enriched = enrichNode(
                {
                    metadataType: 'CustomTab',
                    name: 'Gym_Trainer__c'
                },
                [
                    'force-app/main/default/tabs/Gym_Trainer__c.tab-meta.xml'
                ]
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(
                enriched.filePath,
                'force-app/main/default/tabs/Gym_Trainer__c.tab-meta.xml'
            );
        }
    );

    await runTest(
        'comparison remains path-based and will include retrieved CustomTab files',
        () => {
            const compareSource = fs.readFileSync(
                path.join(__dirname, '../controllers/compare.controller.js'),
                'utf8'
            );

            assert.ok(
                compareSource.includes('git diff --name-status'),
                'comparison still uses git path diffs'
            );
            assert.ok(
                !compareSource.includes("metadataType === 'CustomObject'"),
                'comparison does not hard-filter metadata types'
            );
        }
    );

    await runTest(
        'AI semantic validator recognizes CustomTab metadata mentions',
        () => {
            const source = fs.readFileSync(
                path.join(
                    __dirname,
                    'aiSemanticAdvisor/semanticValidator.service.js'
                ),
                'utf8'
            );

            assert.ok(
                source.includes('CustomTab'),
                'CustomTab must be part of invented-metadata mention pattern'
            );
        }
    );
}

main();
