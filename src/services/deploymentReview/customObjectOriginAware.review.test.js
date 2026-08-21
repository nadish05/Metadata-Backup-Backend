/**
 * Origin-aware CustomObject Deployment Review.
 *
 * PRIMARY_SELECTION → full field enumeration
 * RELATIONSHIP_TARGET → relationship-only (no artificial fields)
 */

const assert = require('assert');

const {
    reviewDeployableMetadataItems,
    METADATA_ORIGINS
} = require('../deploymentReview.service');

const {
    shouldEnumerateCustomObjectChildren,
    resolveMetadataOrigin
} = require('../dependencyResolution/metadataGraphOrigin.model');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

const OBJECT_PATH =
    'force-app/main/default/objects/Session__c/Session__c.object-meta.xml';

const REPO_FILES = [
    OBJECT_PATH,
    'force-app/main/default/objects/Session__c/fields/Date__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Experience__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Available_Slots__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Price__c.field-meta.xml'
];

async function listRepoFiles() {
    return REPO_FILES;
}

async function readRepoFile(filePath) {
    if (filePath === OBJECT_PATH) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Session</label>
    <pluralLabel>Sessions</pluralLabel>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;
    }

    throw new Error(`Unexpected read: ${filePath}`);
}

async function main() {
    await runTest('origin model: PRIMARY and CUSTOM_METADATA_PARENT enumerate children', () => {
        assert.strictEqual(
            shouldEnumerateCustomObjectChildren(
                METADATA_ORIGINS.PRIMARY_SELECTION
            ),
            true
        );
        assert.strictEqual(
            shouldEnumerateCustomObjectChildren(
                METADATA_ORIGINS.CUSTOM_METADATA_PARENT
            ),
            true
        );
        assert.strictEqual(
            shouldEnumerateCustomObjectChildren(
                METADATA_ORIGINS.RELATIONSHIP_TARGET
            ),
            false
        );
        assert.strictEqual(
            shouldEnumerateCustomObjectChildren(
                METADATA_ORIGINS.DIRECT_DEPENDENCY
            ),
            false
        );
        assert.strictEqual(
            shouldEnumerateCustomObjectChildren(
                METADATA_ORIGINS.SECONDARY_DEPENDENCY
            ),
            false
        );
        assert.strictEqual(shouldEnumerateCustomObjectChildren(null), true);
        assert.strictEqual(
            resolveMetadataOrigin(
                { origin: METADATA_ORIGINS.RELATIONSHIP_TARGET },
                METADATA_ORIGINS.PRIMARY_SELECTION
            ),
            METADATA_ORIGINS.RELATIONSHIP_TARGET
        );
        assert.strictEqual(
            resolveMetadataOrigin(
                { origin: METADATA_ORIGINS.CUSTOM_METADATA_PARENT },
                METADATA_ORIGINS.RELATIONSHIP_TARGET
            ),
            METADATA_ORIGINS.CUSTOM_METADATA_PARENT
        );
    });

    await runTest(
        'PRIMARY_SELECTION CustomObject review enumerates all fields including Price__c',
        async () => {
            const result = await reviewDeployableMetadataItems({
                items: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Session__c',
                        filePath: OBJECT_PATH,
                        origin: METADATA_ORIGINS.PRIMARY_SELECTION
                    }
                ],
                readRepoFile,
                listRepoFiles,
                defaultOrigin: METADATA_ORIGINS.PRIMARY_SELECTION
            });

            const review = result.deploymentReview[0];
            assert.strictEqual(review.status, 'SUCCESS');
            assert.strictEqual(review.reviewStrategy, 'FULL_OBJECT');
            assert.strictEqual(
                review.origin,
                METADATA_ORIGINS.PRIMARY_SELECTION
            );

            const fieldNames = (result.requiredDependencies || [])
                .filter((d) => d.type === 'CustomField')
                .map((d) => d.name);

            assert.ok(
                fieldNames.includes('Session__c.Price__c'),
                `Expected Price__c in primary review, got: ${fieldNames.join(', ')}`
            );
            assert.ok(
                fieldNames.includes('Session__c.Date__c'),
                'Expected Date__c in primary review'
            );
        }
    );

    await runTest(
        'RELATIONSHIP_TARGET CustomObject review does NOT invent Price__c',
        async () => {
            const result = await reviewDeployableMetadataItems({
                items: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Session__c',
                        filePath: OBJECT_PATH,
                        origin: METADATA_ORIGINS.RELATIONSHIP_TARGET
                    }
                ],
                readRepoFile,
                listRepoFiles,
                defaultOrigin: METADATA_ORIGINS.RELATIONSHIP_TARGET
            });

            const review = result.deploymentReview[0];
            assert.strictEqual(review.status, 'SUCCESS');
            assert.strictEqual(review.reviewStrategy, 'RELATIONSHIP_ONLY');
            assert.strictEqual(
                review.origin,
                METADATA_ORIGINS.RELATIONSHIP_TARGET
            );
            assert.deepStrictEqual(result.requiredDependencies, []);

            const fieldNames = (result.requiredDependencies || [])
                .filter((d) => d.type === 'CustomField')
                .map((d) => d.name);

            assert.ok(
                !fieldNames.includes('Session__c.Price__c'),
                'RELATIONSHIP_TARGET must not invent Price__c'
            );
        }
    );

    await runTest(
        'CUSTOM_METADATA_PARENT CustomObject review enumerates fields like PRIMARY',
        async () => {
            const result = await reviewDeployableMetadataItems({
                items: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Session__c',
                        filePath: OBJECT_PATH,
                        origin: METADATA_ORIGINS.CUSTOM_METADATA_PARENT
                    }
                ],
                readRepoFile,
                listRepoFiles,
                defaultOrigin: METADATA_ORIGINS.RELATIONSHIP_TARGET
            });

            const review = result.deploymentReview[0];
            assert.strictEqual(review.status, 'SUCCESS');
            assert.strictEqual(review.reviewStrategy, 'FULL_OBJECT');
            assert.strictEqual(
                review.origin,
                METADATA_ORIGINS.CUSTOM_METADATA_PARENT
            );

            const fieldNames = (result.requiredDependencies || [])
                .filter((d) => d.type === 'CustomField')
                .map((d) => d.name);

            assert.ok(
                fieldNames.includes('Session__c.Price__c'),
                `Expected Price__c for CUSTOM_METADATA_PARENT, got: ${fieldNames.join(', ')}`
            );
        }
    );

    await runTest(
        'defaultOrigin RELATIONSHIP_TARGET applies when item.origin omitted',
        async () => {
            const result = await reviewDeployableMetadataItems({
                items: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Session__c',
                        filePath: OBJECT_PATH
                    }
                ],
                readRepoFile,
                listRepoFiles,
                defaultOrigin: METADATA_ORIGINS.RELATIONSHIP_TARGET
            });

            assert.strictEqual(
                result.deploymentReview[0].reviewStrategy,
                'RELATIONSHIP_ONLY'
            );
            assert.deepStrictEqual(result.requiredDependencies, []);
        }
    );

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

main();
