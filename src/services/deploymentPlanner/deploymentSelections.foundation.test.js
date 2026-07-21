const assert = require('assert');

const {
    normalizeDeploymentSelections,
    extractDeploymentSelections,
    attachReservedDeploymentSelections
} = require('./deploymentSelections.foundation');

const deploymentPackageService = require('../deploymentPackage.service');

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

runTest('empty / missing selections normalize to []', () => {
    assert.deepStrictEqual(normalizeDeploymentSelections(undefined), []);
    assert.deepStrictEqual(normalizeDeploymentSelections(null), []);
    assert.deepStrictEqual(normalizeDeploymentSelections([]), []);
    assert.deepStrictEqual(extractDeploymentSelections(null), []);
    assert.deepStrictEqual(extractDeploymentSelections({}), []);
});

runTest('valid selections are normalized and deduped', () => {
    const result = normalizeDeploymentSelections([
        {
            type: 'LightningComponentBundle',
            name: 'myCmp',
            action: 'SKIP'
        },
        {
            metadataType: 'LightningComponentBundle',
            metadataName: 'myCmp',
            choice: 'DEPLOY'
        },
        { metadataType: 'FlexiPage', metadataName: 'Home', choice: 'skip' },
        { metadataType: 'ApexClass', metadataName: 'Foo' }
    ]);

    assert.deepStrictEqual(result, [
        {
            metadataType: 'FlexiPage',
            metadataName: 'Home',
            choice: 'SKIP'
        },
        {
            metadataType: 'LightningComponentBundle',
            metadataName: 'myCmp',
            choice: 'SKIP'
        }
    ]);
});

runTest('attach returns same package reference when no selections', () => {
    const pkg = {
        selectedMetadata: [
            {
                metadataType: 'ApexClass',
                metadataName: 'Foo',
                filePath: 'classes/Foo.cls'
            }
        ],
        requiredDependencies: []
    };

    const attached = attachReservedDeploymentSelections(pkg, undefined);
    assert.strictEqual(attached, pkg);
});

runTest('attach stores selections without changing deploy inventory fields', () => {
    const pkg = {
        selectedMetadata: [
            {
                metadataType: 'ApexClass',
                metadataName: 'Foo',
                filePath: 'classes/Foo.cls'
            }
        ],
        requiredDependencies: [
            {
                type: 'CustomObject',
                name: 'Account__c',
                required: true,
                selected: true,
                action: 'DEPLOY'
            }
        ]
    };

    const attached = attachReservedDeploymentSelections(pkg, [
        {
            metadataType: 'CustomObject',
            metadataName: 'Account__c',
            choice: 'SKIP'
        }
    ]);

    assert.notStrictEqual(attached, pkg);
    assert.deepStrictEqual(attached.selectedMetadata, pkg.selectedMetadata);
    assert.deepStrictEqual(
        attached.requiredDependencies,
        pkg.requiredDependencies
    );
    assert.deepStrictEqual(attached.deploymentSelections, [
        {
            metadataType: 'CustomObject',
            metadataName: 'Account__c',
            choice: 'SKIP'
        }
    ]);
});

runTest(
    'Package Generation ignores reserved deploymentSelections (no behaviour change)',
    () => {
        const basePackage = {
            selectedMetadata: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'Foo',
                    filePath: 'classes/Foo.cls'
                }
            ],
            requiredDependencies: [
                {
                    type: 'CustomObject',
                    name: 'Bar__c',
                    required: true,
                    selected: true,
                    action: 'DEPLOY'
                }
            ],
            selectedTestClasses: []
        };

        const withSelections = {
            ...basePackage,
            deploymentSelections: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Bar__c',
                    choice: 'SKIP'
                }
            ]
        };

        const without = deploymentPackageService.generateDeploymentPackage(
            basePackage
        );
        const withSel = deploymentPackageService.generateDeploymentPackage(
            withSelections
        );

        assert.deepStrictEqual(withSel, without);
    }
);

if (process.exitCode) {
    console.error('deploymentSelections.foundation tests failed');
} else {
    console.log('deploymentSelections.foundation tests passed');
}
