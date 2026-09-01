const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    METADATA_KINDS,
    METADATA_TYPE_RULES,
    getMetadataTypeRule
} = require('../config/metadataTypes');
const {
    RETRIEVAL_METADATA_TYPES,
    buildRetrieveMetadataMembers,
    buildRetrieveMetadataArgs
} = require('../controllers/metadata.controller');
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
const {
    isSupportedMetadataType,
    extensionMatchesMetadataType
} = require('./metadataValidation.service');
const { generatePackageXml } = require('./packageXml.service');
const {
    isSupportedReviewMetadataType,
    SUPPORTED_REVIEW_METADATA_TYPES,
    reviewDeployableMetadataItems
} = require('./deploymentReview.service');

const LAYOUT_PATH =
    'force-app/main/default/layouts/Account-Account Layout.layout-meta.xml';

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
    await runTest('Layout is a first-class METADATA_TYPE_RULES entry', () => {
        const rule = getMetadataTypeRule('Layout');

        assert.ok(METADATA_TYPE_RULES.Layout);
        assert.strictEqual(rule.kind, METADATA_KINDS.FILE);
        assert.strictEqual(rule.folder, 'layouts');
        assert.strictEqual(rule.extension, '.layout-meta.xml');
        assert.strictEqual(rule.requiresMetaXml, false);
        assert.strictEqual(
            getArtifactResolver('Layout').id,
            'GenericFileArtifactResolver'
        );
    });

    await runTest('RETRIEVAL_METADATA_TYPES includes Layout', () => {
        assert.ok(RETRIEVAL_METADATA_TYPES.includes('Layout'));
        assert.ok(buildRetrieveMetadataMembers().includes('Layout'));
    });

    await runTest('buildRetrieveMetadataArgs includes -m Layout', () => {
        const args = buildRetrieveMetadataArgs();

        assert.ok(args.includes('-m Layout'));
    });

    await runTest(
        'retrieve-all metadata type list includes Layout',
        () => {
            const arrays = extractMetadataTypeArrays(readControllerSource());

            assert.ok(arrays.length >= 1, 'expected retrieve-all metadataTypes list');
            assert.ok(
                arrays.every((types) => types.includes('Layout')),
                `Layout missing from retrieve-all list: ${JSON.stringify(arrays)}`
            );
        }
    );

    await runTest('Layout artifact resolution locates layouts folder files', () => {
        const repoFiles = [
            LAYOUT_PATH,
            'force-app/main/default/layouts/Account-Admin Layout.layout-meta.xml',
            'force-app/main/default/layouts/Contact-Contact Layout.layout-meta.xml'
        ];

        const accountLayout = enrichNode(
            {
                metadataType: 'Layout',
                name: 'Account-Account Layout'
            },
            repoFiles
        );

        assert.strictEqual(accountLayout.artifactResolved, true);
        assert.strictEqual(accountLayout.filePath, LAYOUT_PATH);

        const adminLayout = enrichNode(
            {
                metadataType: 'Layout',
                name: 'Account-Admin Layout'
            },
            repoFiles
        );

        assert.strictEqual(adminLayout.artifactResolved, true);
        assert.strictEqual(
            adminLayout.filePath,
            'force-app/main/default/layouts/Account-Admin Layout.layout-meta.xml'
        );

        const contactLayout = enrichNode(
            {
                metadataType: 'Layout',
                name: 'Contact-Contact Layout'
            },
            repoFiles
        );

        assert.strictEqual(contactLayout.artifactResolved, true);
        assert.strictEqual(
            contactLayout.filePath,
            'force-app/main/default/layouts/Contact-Contact Layout.layout-meta.xml'
        );
    });

    await runTest('metadata validation recognizes Layout through METADATA_TYPE_RULES', () => {
        assert.strictEqual(isSupportedMetadataType('Layout'), true);
        assert.strictEqual(
            extensionMatchesMetadataType(LAYOUT_PATH, 'Layout'),
            true
        );
    });

    await runTest(
        'dependency validation treats Layout as a supported packageable type',
        async () => {
            const classification = classifyDependency({
                type: 'Layout',
                name: 'Account-Account Layout'
            });

            assert.strictEqual(
                classification.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA
            );
            assert.strictEqual(classification.artifactRequired, true);
            assert.strictEqual(classification.packageable, true);

            const packageWithLayout = {
                metadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: 'Account-Account Layout'
                    }
                ],
                dependencies: []
            };

            const exists = await validateDependencies({
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com',
                generatedDeploymentPackage: packageWithLayout,
                destinationStates: new Map([
                    ['Layout:Account-Account Layout', 'EXISTS']
                ])
            });

            assert.strictEqual(exists.overallStatus, 'PASS');
            assert.strictEqual(exists.results[0].type, 'Layout');
            assert.strictEqual(exists.results[0].status, 'PASS');
            assert.ok(
                !String(exists.results[0].message || '').includes(
                    'validation is not supported'
                )
            );
        }
    );

    await runTest('package.xml generation includes Layout members', () => {
        const packageXml = generatePackageXml({
            metadata: [
                {
                    metadataType: 'Layout',
                    metadataName: 'Account-Account Layout'
                }
            ]
        });

        assert.match(packageXml, /<name>Layout<\/name>/);
        assert.match(
            packageXml,
            /<members>Account-Account Layout<\/members>/
        );
    });

    await runTest('deployment review allowlists Layout', () => {
        assert.ok(SUPPORTED_REVIEW_METADATA_TYPES.has('Layout'));
        assert.strictEqual(isSupportedReviewMetadataType('Layout'), true);
    });

    await runTest('deployment review returns SUCCESS for Layout', async () => {
        const result = await reviewDeployableMetadataItems({
            items: [
                {
                    metadataType: 'Layout',
                    metadataName: 'Account-Account Layout',
                    filePath: LAYOUT_PATH
                }
            ],
            readRepoFile: async () => '<Layout xmlns="http://soap.sforce.com/2006/04/metadata"></Layout>',
            listRepoFiles: async () => [LAYOUT_PATH]
        });

        assert.strictEqual(result.deploymentReview.length, 1);
        assert.strictEqual(result.deploymentReview[0].metadataType, 'Layout');
        assert.strictEqual(
            result.deploymentReview[0].metadataName,
            'Account-Account Layout'
        );
        assert.strictEqual(result.deploymentReview[0].status, 'SUCCESS');
        assert.notStrictEqual(
            result.deploymentReview[0].status,
            'NOT_SUPPORTED_YET'
        );
    });
}

main();
