'use strict';

const assert = require('assert');

const {
    fromSalesforceSnapshot,
    toSalesforceSnapshotPayload
} = require('../controlPlane/controlPlane.snapshotMapping');
const {
    resolveRollbackDestinationRetrieveSourceApiVersion,
    resolveRollbackDestinationRetrieveSourceApiVersionWithDestinationCap
} = require('./rollbackDestinationRetrieveApiVersion.service');
const { DEFAULT_API_VERSION } = require('../../config/salesforce');

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

(async () => {
    await runTest('snapshot mapping round-trips sourceMetadataApiVersion 66.0', () => {
        const payload = toSalesforceSnapshotPayload({
            snapshotId: 'snapshot_test',
            destinationOrgId: '00Ddest',
            sourceMetadataApiVersion: '66.0'
        });

        assert.strictEqual(payload.sourceMetadataApiVersion, '66.0');

        const snapshot = fromSalesforceSnapshot({
            Snapshot_Id__c: 'snapshot_test',
            Destination_Org_Id__c: '00Ddest',
            Source_Metadata_API_Version__c: '66.0'
        });

        assert.strictEqual(snapshot.sourceMetadataApiVersion, '66.0');
    });

    await runTest(
        'retrieve selection prefers snapshot sourceMetadataApiVersion 66.0',
        () => {
            const result = resolveRollbackDestinationRetrieveSourceApiVersion({
                snapshotSourceMetadataApiVersion: '66.0',
                deploymentApiVersion: '61.0',
                destinationMaxApiVersion: '67.0'
            });

            assert.strictEqual(result.effectiveRetrieveApiVersion, '66.0');
            assert.strictEqual(
                result.retrieveApiVersionSelection,
                'SNAPSHOT_SOURCE_METADATA'
            );
        }
    );

    await runTest('destination API cap min(source, destinationMax)', () => {
        const result = resolveRollbackDestinationRetrieveSourceApiVersion({
            snapshotSourceMetadataApiVersion: '66.0',
            deploymentApiVersion: '61.0',
            destinationMaxApiVersion: '65.0'
        });

        assert.strictEqual(result.effectiveRetrieveApiVersion, '65.0');
    });

    await runTest(
        'missing snapshot sourceMetadataApiVersion falls back to deploymentApiVersion',
        () => {
            const result = resolveRollbackDestinationRetrieveSourceApiVersion({
                snapshotSourceMetadataApiVersion: null,
                deploymentApiVersion: '61.0'
            });

            assert.strictEqual(result.effectiveRetrieveApiVersion, '61.0');
            assert.strictEqual(
                result.retrieveApiVersionSelection,
                'DEPLOYMENT_API_VERSION_FALLBACK'
            );
        }
    );

    await runTest(
        'invalid snapshot sourceMetadataApiVersion falls back to deploymentApiVersion',
        () => {
            const result = resolveRollbackDestinationRetrieveSourceApiVersion({
                snapshotSourceMetadataApiVersion: 'not-a-version',
                deploymentApiVersion: '62.0'
            });

            assert.strictEqual(result.effectiveRetrieveApiVersion, '62.0');
            assert.strictEqual(
                result.retrieveApiVersionSelection,
                'DEPLOYMENT_API_VERSION_FALLBACK'
            );
        }
    );

    await runTest(
        'missing snapshot and deployment versions use DEFAULT_FALLBACK selection',
        () => {
            const result = resolveRollbackDestinationRetrieveSourceApiVersion({});

            assert.strictEqual(result.effectiveRetrieveApiVersion, null);
            assert.strictEqual(
                result.retrieveApiVersionSelection,
                'DEFAULT_FALLBACK'
            );
            assert.strictEqual(result.defaultApiVersion, DEFAULT_API_VERSION);
        }
    );

    await runTest(
        'async resolver uses stored source when destination max unavailable',
        async () => {
            const result =
                await resolveRollbackDestinationRetrieveSourceApiVersionWithDestinationCap(
                    {
                        snapshot: { sourceMetadataApiVersion: '66.0' },
                        deploymentApiVersion: null,
                        getLatestApiVersionFn: async () => {
                            throw new Error('network');
                        }
                    }
                );

            assert.strictEqual(result.effectiveRetrieveApiVersion, '66.0');
        }
    );
})();
