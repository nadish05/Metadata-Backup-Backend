'use strict';

const assert = require('assert');

const { enrichCompareFlowFileEntry } = require('./compareFlowEnrichment.service');

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

runTest('versioned flow compare entries remain distinct', () => {
    const v1 = enrichCompareFlowFileEntry({
        filePath: 'force-app/main/default/flows/Get_Customer_Details-1.flow-meta.xml',
        changeType: 'MODIFIED',
        flowStatus: 'Obsolete',
        fileContent: '<Flow><status>Obsolete</status></Flow>',
        manifestArtifacts: [
            {
                workspaceArtifactPath:
                    'force-app/main/default/flows/Get_Customer_Details-1.flow-meta.xml',
                sourceFlowVersionId: 'id-1',
                sourceFlowVersionNumber: 1,
                artifactSha256: 'abc'
            }
        ]
    });

    const v2 = enrichCompareFlowFileEntry({
        filePath: 'force-app/main/default/flows/Get_Customer_Details-2.flow-meta.xml',
        changeType: 'MODIFIED',
        flowStatus: 'Draft',
        fileContent: '<Flow><status>Draft</status></Flow>',
        manifestArtifacts: [
            {
                workspaceArtifactPath:
                    'force-app/main/default/flows/Get_Customer_Details-2.flow-meta.xml',
                sourceFlowVersionId: 'id-2',
                sourceFlowVersionNumber: 2
            }
        ]
    });

    assert.notStrictEqual(v1.selectionIdentity, v2.selectionIdentity);
    assert.strictEqual(v1.sourceFlowVersionNumber, 1);
    assert.strictEqual(v2.sourceFlowVersionNumber, 2);
    assert.strictEqual(v1.selectedMetadataMemberName, 'Get_Customer_Details-1');
    assert.strictEqual(v2.selectedMetadataMemberName, 'Get_Customer_Details-2');
});

runTest('legacy flow compare entry keeps base fields', () => {
    const entry = enrichCompareFlowFileEntry({
        filePath: 'force-app/main/default/classes/Foo.cls',
        changeType: 'MODIFIED',
        flowStatus: null
    });

    assert.strictEqual(entry.filePath, 'force-app/main/default/classes/Foo.cls');
    assert.strictEqual(entry.selectionIdentity, undefined);
});
