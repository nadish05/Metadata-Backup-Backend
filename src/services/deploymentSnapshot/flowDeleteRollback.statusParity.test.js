'use strict';

const assert = require('assert');

const {
    tryFlowStatusOnlySealedHashParity,
    evaluateFlowDeleteRollbackStatusParity,
    analyzeFlowRootStatusElement,
    hashPackedFlowMember,
    FLOW_DELETE_STATUS_ONLY_PARITY_V1
} = require('./flowDeleteRollbackStatusParity.service');
const {
    compareNewMemberForDeleteRollback,
    DRIFT_CLASSIFICATION
} = require('./snapshotDriftComparison.service');
const {
    packMemberFiles
} = require('./destinationMemberArtifact.service');
const {
    applyCanonicalFlowSnapshotPackPaths
} = require('../flowMetadata/flowMemberIdentity.service');
const { hashBytes } = require('./snapshotIntegrity.service');

const METADATA_NAME = 'Check_Amount-4';
const FLOW_PATH = `force-app/main/default/flows/${METADATA_NAME}.flow-meta.xml`;

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

function buildFlowXml(status) {
    return Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
            `    <apiVersion>61.0</apiVersion>\n` +
            `    <label>Check Amount</label>\n` +
            `    <processType>AutoLaunchedFlow</processType>\n` +
            `    <status>${status}</status>\n` +
            `</Flow>\n`,
        'utf8'
    );
}

function packFlow(xmlBytes) {
    return packMemberFiles(
        applyCanonicalFlowSnapshotPackPaths(
            [{ relativePath: FLOW_PATH, bytes: xmlBytes }],
            METADATA_NAME
        )
    );
}

function mockDiscoveryForVersion4(status = 'Draft') {
    return async () => ({
        apiVersion: '61.0',
        versions: [
            {
                flowDefinitionDeveloperName: 'Check_Amount',
                sourceFlowVersionNumber: 4,
                sourceFlowVersionId: '301NS00003Eov6NYAR',
                flowVersionStatus: status,
                flowIsLatestVersion: true,
                flowIsActiveVersion: false
            }
        ],
        definitions: []
    });
}

(async () => {
    const obsoleteXml = buildFlowXml('Obsolete');
    const draftXml = buildFlowXml('Draft');
    const sealedHash = hashBytes(packFlow(obsoleteXml));
    const destinationHash = hashBytes(packFlow(draftXml));

    await runTest('A. RAW hashes match — no status parity required', () => {
        const comparison = compareNewMemberForDeleteRollback({
            expectedAfterHash: sealedHash,
            currentDestinationHash: sealedHash
        });
        assert.strictEqual(
            comparison.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
        const parity = tryFlowStatusOnlySealedHashParity({
            destinationFlowXmlBytes: obsoleteXml,
            metadataName: METADATA_NAME,
            expectedAfterHash: sealedHash,
            currentDestinationHash: sealedHash
        });
        assert.strictEqual(parity.qualified, false);
        assert.strictEqual(parity.reason, 'RAW_HASH_ALREADY_MATCHES');
    });

    await runTest(
        'B. Obsolete sealed vs Draft destination qualifies via status-only parity',
        async () => {
            const raw = compareNewMemberForDeleteRollback({
                expectedAfterHash: sealedHash,
                currentDestinationHash: destinationHash
            });
            assert.strictEqual(raw.classification, DRIFT_CLASSIFICATION.DRIFTED);
            assert.notStrictEqual(sealedHash, destinationHash);

            const parity = tryFlowStatusOnlySealedHashParity({
                destinationFlowXmlBytes: draftXml,
                metadataName: METADATA_NAME,
                expectedAfterHash: sealedHash,
                currentDestinationHash: destinationHash
            });
            assert.strictEqual(parity.qualified, true);
            assert.strictEqual(parity.destinationStatus, 'Draft');
            assert.strictEqual(parity.qualifyingStatus, 'Obsolete');

            const evaluated = await evaluateFlowDeleteRollbackStatusParity({
                metadataName: METADATA_NAME,
                expectedAfterHash: sealedHash,
                currentDestinationHash: destinationHash,
                destinationArtifactBytes: packFlow(draftXml),
                retrieved: { flowExactVersionArtifactVerified: true },
                accessToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com',
                discoverFlowVersionsFn: mockDiscoveryForVersion4('Draft')
            });
            assert.strictEqual(evaluated.qualified, true);
            assert.strictEqual(
                evaluated.comparisonMode,
                FLOW_DELETE_STATUS_ONLY_PARITY_V1
            );
        }
    );

    await runTest('C. status plus logic change rejects parity', () => {
        const mutatedDraft = Buffer.from(
            draftXml.toString('utf8').replace(
                '<processType>AutoLaunchedFlow</processType>',
                '<processType>Flow</processType>'
            ),
            'utf8'
        );
        const parity = tryFlowStatusOnlySealedHashParity({
            destinationFlowXmlBytes: mutatedDraft,
            metadataName: METADATA_NAME,
            expectedAfterHash: sealedHash,
            currentDestinationHash: hashBytes(packFlow(mutatedDraft))
        });
        assert.strictEqual(parity.qualified, false);
        assert.strictEqual(
            parity.reason,
            'NO_STATUS_CANDIDATE_MATCHES_SEALED_HASH'
        );
    });

    await runTest('D. ambiguous / missing Flow version rejects parity', async () => {
        const missing = await evaluateFlowDeleteRollbackStatusParity({
            metadataName: METADATA_NAME,
            expectedAfterHash: sealedHash,
            currentDestinationHash: destinationHash,
            destinationArtifactBytes: packFlow(draftXml),
            retrieved: { flowExactVersionArtifactVerified: true },
            accessToken: 'token',
            instanceUrl: 'https://example.my.salesforce.com',
            discoverFlowVersionsFn: async () => ({
                apiVersion: '61.0',
                versions: [],
                definitions: []
            })
        });
        assert.strictEqual(missing.qualified, false);
        assert.strictEqual(missing.reason, 'DESTINATION_FLOW_VERSION_NOT_FOUND');

        const ambiguous = await evaluateFlowDeleteRollbackStatusParity({
            metadataName: METADATA_NAME,
            expectedAfterHash: sealedHash,
            currentDestinationHash: destinationHash,
            destinationArtifactBytes: packFlow(draftXml),
            retrieved: { flowExactVersionArtifactVerified: true },
            accessToken: 'token',
            instanceUrl: 'https://example.my.salesforce.com',
            discoverFlowVersionsFn: async () => ({
                apiVersion: '61.0',
                versions: [
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 4,
                        sourceFlowVersionId: 'A'
                    },
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 4,
                        sourceFlowVersionId: 'B'
                    }
                ],
                definitions: []
            })
        });
        assert.strictEqual(ambiguous.qualified, false);
        assert.strictEqual(ambiguous.reason, 'AMBIGUOUS_DESTINATION_FLOW_VERSION');
    });

    await runTest('E. Active destination Flow rejects parity', async () => {
        const result = await evaluateFlowDeleteRollbackStatusParity({
            metadataName: METADATA_NAME,
            expectedAfterHash: sealedHash,
            currentDestinationHash: destinationHash,
            destinationArtifactBytes: packFlow(draftXml),
            retrieved: { flowExactVersionArtifactVerified: true },
            accessToken: 'token',
            instanceUrl: 'https://example.my.salesforce.com',
            discoverFlowVersionsFn: mockDiscoveryForVersion4('Active')
        });
        assert.strictEqual(result.qualified, false);
        assert.strictEqual(result.reason, 'DESTINATION_FLOW_VERSION_ACTIVE');
    });

    await runTest('F. Tooling API failure fails closed', async () => {
        const result = await evaluateFlowDeleteRollbackStatusParity({
            metadataName: METADATA_NAME,
            expectedAfterHash: sealedHash,
            currentDestinationHash: destinationHash,
            destinationArtifactBytes: packFlow(draftXml),
            retrieved: { flowExactVersionArtifactVerified: true },
            accessToken: 'token',
            instanceUrl: 'https://example.my.salesforce.com',
            discoverFlowVersionsFn: async () => {
                throw new Error('tooling down');
            }
        });
        assert.strictEqual(result.qualified, false);
        assert.strictEqual(result.reason, 'TOOLING_DISCOVERY_FAILED');
    });

    await runTest('G. malformed XML and bad status fail closed', () => {
        assert.strictEqual(
            analyzeFlowRootStatusElement(Buffer.from('<not-flow/>', 'utf8')).ok,
            false
        );
        const duplicateStatus = Buffer.from(
            '<Flow><status>Draft</status><status>Obsolete</status></Flow>',
            'utf8'
        );
        assert.strictEqual(
            analyzeFlowRootStatusElement(duplicateStatus).reason,
            'MULTIPLE_STATUS_ELEMENTS'
        );
        const unsupported = Buffer.from(
            '<Flow><status>Inactive</status></Flow>',
            'utf8'
        );
        assert.strictEqual(
            analyzeFlowRootStatusElement(unsupported).reason,
            'UNSUPPORTED_STATUS_VALUE'
        );
    });

    await runTest('H. missing expectedAfterHash preserves fail-closed drift', () => {
        const comparison = compareNewMemberForDeleteRollback({
            expectedAfterHash: null,
            currentDestinationHash: destinationHash
        });
        assert.strictEqual(
            comparison.classification,
            'MISSING_EXPECTED_AFTER'
        );
    });

    await runTest('I. ApexClass drift path does not use Flow parity helper', async () => {
        const clsBytes = Buffer.from('public class Demo {}\n', 'utf8');
        const packed = packMemberFiles([
            {
                relativePath: 'force-app/main/default/classes/Demo.cls',
                bytes: clsBytes
            }
        ]);
        const result = await evaluateFlowDeleteRollbackStatusParity({
            metadataName: 'Demo',
            expectedAfterHash: hashBytes(packed),
            currentDestinationHash: hashBytes(packed),
            destinationArtifactBytes: packed,
            retrieved: { flowExactVersionArtifactVerified: true },
            accessToken: 'token',
            instanceUrl: 'https://example.my.salesforce.com',
            discoverFlowVersionsFn: mockDiscoveryForVersion4()
        });
        assert.strictEqual(result.qualified, false);
        assert.strictEqual(result.reason, 'NOT_VERSION_QUALIFIED');
    });

    await runTest('hashPackedFlowMember uses production SNAPMEM1 path', () => {
        assert.strictEqual(hashPackedFlowMember(obsoleteXml, METADATA_NAME), sealedHash);
    });
})();
