const assert = require('assert');

const {
    getFlowApiName,
    extractFlowApiVersion,
    analyzeFlowReview,
    DEPENDENCIES_NOT_YET_ANALYZED
} = require('./flowReview.service');

const {
    reviewDeployableMetadataItems,
    isSupportedReviewMetadataType,
    SUPPORTED_REVIEW_METADATA_TYPES
} = require('../deploymentReview.service');

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

const FLOW_PATH =
    'force-app/main/default/flows/My_Sample_Flow.flow-meta.xml';

const FLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>63.0</apiVersion>
    <status>Active</status>
    <processType>AutoLaunchedFlow</processType>
</Flow>
`;

async function main() {
    await runTest('Flow is on the Review allowlist', () => {
        assert.ok(SUPPORTED_REVIEW_METADATA_TYPES.has('Flow'));
        assert.strictEqual(isSupportedReviewMetadataType('Flow'), true);
    });

    await runTest('getFlowApiName strips .flow-meta.xml correctly', () => {
        assert.strictEqual(getFlowApiName(FLOW_PATH), 'My_Sample_Flow');
        assert.strictEqual(
            getFlowApiName('force-app/main/default/flows/MyFlow.flow-meta.xml'),
            'MyFlow'
        );
    });

    await runTest('extractFlowApiVersion reads embedded apiVersion', () => {
        assert.strictEqual(extractFlowApiVersion(FLOW_XML), '63.0');
        assert.strictEqual(extractFlowApiVersion('<Flow></Flow>'), null);
    });

    await runTest('analyzeFlowReview returns SUCCESS with API version', () => {
        const result = analyzeFlowReview({
            content: FLOW_XML,
            filePath: FLOW_PATH
        });

        assert.strictEqual(result.metadataType, 'Flow');
        assert.strictEqual(result.metadataName, 'My_Sample_Flow');
        assert.strictEqual(result.status, 'SUCCESS');
        assert.strictEqual(result.apiValidation.apiVersion, '63.0');
        assert.strictEqual(result.apiValidation.supported, true);
        assert.strictEqual(
            result.dependencyAnalysis.analysisStatus,
            'NOT_YET_ANALYZED'
        );
        assert.strictEqual(
            result.dependencyAnalysis.message,
            DEPENDENCIES_NOT_YET_ANALYZED
        );
        assert.deepStrictEqual(
            result.dependencyAnalysis.requiredDependencies,
            []
        );
    });

    await runTest(
        'reviewDeployableMetadataItems reviews Flow instead of NOT_SUPPORTED_YET',
        async () => {
            const result = await reviewDeployableMetadataItems({
                items: [
                    {
                        metadataType: 'Flow',
                        filePath: FLOW_PATH
                    }
                ],
                readRepoFile: async () => FLOW_XML,
                listRepoFiles: async () => [FLOW_PATH]
            });

            assert.strictEqual(result.reviewsExecuted, 1);
            assert.strictEqual(result.deploymentReview.length, 1);

            const review = result.deploymentReview[0];

            assert.strictEqual(review.status, 'SUCCESS');
            assert.notStrictEqual(review.status, 'NOT_SUPPORTED_YET');
            assert.strictEqual(review.metadataType, 'Flow');
            assert.strictEqual(review.metadataName, 'My_Sample_Flow');
            assert.strictEqual(review.apiValidation.apiVersion, '63.0');
            assert.strictEqual(
                review.dependencyAnalysis.message,
                DEPENDENCIES_NOT_YET_ANALYZED
            );
            assert.deepStrictEqual(result.requiredDependencies, []);
        }
    );

    await runTest(
        'Existing allowlisted types remain supported; LWC still unsupported',
        () => {
            assert.strictEqual(
                isSupportedReviewMetadataType('ApexClass'),
                true
            );
            assert.strictEqual(
                isSupportedReviewMetadataType('CustomObject'),
                true
            );
            assert.strictEqual(
                isSupportedReviewMetadataType('NamedCredential'),
                true
            );
            assert.strictEqual(
                isSupportedReviewMetadataType('ExternalCredential'),
                true
            );
            assert.strictEqual(
                isSupportedReviewMetadataType('LightningComponentBundle'),
                false
            );
        }
    );
}

main();
