const assert = require('assert');

const {
    normalizeDeployableMetadata
} = require('./deployableMetadataNormalizer.service');

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

const LWC_BASE = 'force-app/main/default/lwc/backupDashboard';

runTest('null / non-array input returns empty array', () => {
    assert.deepStrictEqual(normalizeDeployableMetadata(null), []);
    assert.deepStrictEqual(normalizeDeployableMetadata(undefined), []);
    assert.deepStrictEqual(normalizeDeployableMetadata({}), []);
});

runTest('single LWC file → one logical LightningComponentBundle', () => {
    const result = normalizeDeployableMetadata([
        {
            metadataType: 'LightningComponentBundle',
            metadataName: 'backupDashboard',
            filePath: `${LWC_BASE}/backupDashboard.js`
        }
    ]);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].metadataType, 'LightningComponentBundle');
    assert.strictEqual(result[0].metadataName, 'backupDashboard');
    assert.strictEqual(
        result[0].filePath,
        `${LWC_BASE}/backupDashboard.js-meta.xml`
    );
});

runTest('four files in same bundle → one logical component', () => {
    const result = normalizeDeployableMetadata([
        {
            metadataType: 'LightningComponentBundle',
            filePath: `${LWC_BASE}/backupDashboard.html`
        },
        {
            metadataType: 'LightningComponentBundle',
            filePath: `${LWC_BASE}/backupDashboard.js`
        },
        {
            metadataType: 'LightningComponentBundle',
            filePath: `${LWC_BASE}/backupDashboard.css`
        },
        {
            metadataType: 'LightningComponentBundle',
            filePath: `${LWC_BASE}/backupDashboard.js-meta.xml`
        }
    ]);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].metadataType, 'LightningComponentBundle');
    assert.strictEqual(result[0].metadataName, 'backupDashboard');
    assert.strictEqual(
        result[0].filePath,
        `${LWC_BASE}/backupDashboard.js-meta.xml`
    );
    assert.strictEqual(result[0].sourceFiles.length, 4);
});

runTest('different bundles → multiple logical components', () => {
    const result = normalizeDeployableMetadata([
        {
            metadataType: 'LightningComponentBundle',
            filePath: `${LWC_BASE}/backupDashboard.js`
        },
        {
            metadataType: 'LightningComponentBundle',
            filePath:
                'force-app/main/default/lwc/statusBadge/statusBadge.js'
        },
        {
            metadataType: 'LightningComponentBundle',
            filePath: `${LWC_BASE}/backupDashboard.html`
        }
    ]);

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].metadataName, 'backupDashboard');
    assert.strictEqual(result[1].metadataName, 'statusBadge');
    assert.strictEqual(result[0].sourceFiles.length, 2);
    assert.strictEqual(result[1].sourceFiles.length, 1);
});

runTest('non-LWC metadata passes through unchanged', () => {
    const apex = {
        metadataType: 'ApexClass',
        metadataName: 'MyController',
        filePath: 'force-app/main/default/classes/MyController.cls',
        customFlag: true
    };
    const objectItem = {
        metadataType: 'CustomObject',
        metadataName: 'Account__c',
        filePath:
            'force-app/main/default/objects/Account__c/Account__c.object-meta.xml'
    };

    const result = normalizeDeployableMetadata([apex, objectItem]);

    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], apex);
    assert.deepStrictEqual(result[1], objectItem);
    assert.notStrictEqual(result[0], apex);
});

runTest('mixed LWC files and non-LWC → collapse LWC only', () => {
    const result = normalizeDeployableMetadata([
        {
            metadataType: 'ApexClass',
            metadataName: 'Helper',
            filePath: 'force-app/main/default/classes/Helper.cls'
        },
        {
            metadataType: 'LightningComponentBundle',
            filePath: `${LWC_BASE}/backupDashboard.js`
        },
        {
            metadataType: 'LightningComponentBundle',
            filePath: `${LWC_BASE}/backupDashboard.html`
        },
        {
            metadataType: 'CustomObject',
            metadataName: 'Job__c',
            filePath:
                'force-app/main/default/objects/Job__c/Job__c.object-meta.xml'
        }
    ]);

    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].metadataType, 'ApexClass');
    assert.strictEqual(result[1].metadataType, 'LightningComponentBundle');
    assert.strictEqual(result[1].metadataName, 'backupDashboard');
    assert.strictEqual(result[2].metadataType, 'CustomObject');
});

runTest('untyped /lwc path still normalizes to LightningComponentBundle', () => {
    const result = normalizeDeployableMetadata([
        {
            filePath: `${LWC_BASE}/backupDashboard.css`
        }
    ]);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].metadataType, 'LightningComponentBundle');
    assert.strictEqual(result[0].metadataName, 'backupDashboard');
});

runTest('ApexClass is not collapsed even if path contains lwc segment oddly', () => {
    const item = {
        metadataType: 'ApexClass',
        metadataName: 'NotAnLwc',
        filePath: 'force-app/main/default/classes/NotAnLwc.cls'
    };

    const result = normalizeDeployableMetadata([item]);

    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], item);
});
