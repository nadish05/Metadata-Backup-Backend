'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    generateDeploymentPackage,
    resolveProfileOnlyMinimalPackagePolicy,
    evaluateProfileOnlyMinimalPackageEligibility,
    resolveExplicitPrimarySelectedMetadata
} = require('./deploymentPackage.service');
const { generateManifest } = require('./packageXml.service');
const { METADATA_ORIGINS } = require('./dependencyResolution/metadataGraphOrigin.model');
const { normalizeDeployableMetadata } = require('./deployableMetadataNormalizer.service');

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

const sampleDeps = [
    {
        type: 'CustomField',
        name: 'Account.Industry',
        action: 'DEPLOY',
        selected: true,
        required: true
    },
    {
        type: 'CustomObject',
        name: 'Session__c',
        action: 'DEPLOY',
        selected: true,
        required: true
    }
];

const legacyBaseline = () =>
    generateDeploymentPackage({
        selectedMetadata: [
            {
                metadataType: 'Profile',
                metadataName: 'Sales Manager'
            }
        ],
        requiredDependencies: sampleDeps
    });

runTest('policy resolver defaults false and rejects non-boolean', () => {
    assert.strictEqual(
        resolveProfileOnlyMinimalPackagePolicy({}),
        false
    );
    assert.strictEqual(
        resolveProfileOnlyMinimalPackagePolicy({
            deploymentPackage: { profileOnlyMinimalPackage: 'true' }
        }),
        false
    );
    assert.strictEqual(
        resolveProfileOnlyMinimalPackagePolicy({
            topLevel: true
        }),
        true
    );
    assert.strictEqual(
        resolveProfileOnlyMinimalPackagePolicy({
            deploymentPackage: { profileOnlyMinimalPackage: true }
        }),
        true
    );
});

runTest('default regression: option absent matches legacy package metadata', () => {
    const baseline = legacyBaseline();
    const withoutFlag = generateDeploymentPackage({
        selectedMetadata: [
            {
                metadataType: 'Profile',
                metadataName: 'Sales Manager'
            }
        ],
        requiredDependencies: sampleDeps
    });

    assert.deepStrictEqual(
        withoutFlag.metadata.map((m) => `${m.metadataType}:${m.metadataName}`),
        baseline.metadata.map((m) => `${m.metadataType}:${m.metadataName}`)
    );
    assert.deepStrictEqual(withoutFlag.dependencies, baseline.dependencies);
});

runTest('explicit opt-in: single Profile package contains only that Profile', () => {
    const pkg = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        selectedMetadata: [
            {
                metadataType: 'Profile',
                metadataName: 'Sales Manager'
            }
        ],
        requiredDependencies: sampleDeps
    });

    assert.strictEqual(pkg.metadata.length, 1);
    assert.strictEqual(pkg.metadata[0].metadataType, 'Profile');
    assert.strictEqual(pkg.metadata[0].metadataName, 'Sales Manager');
    assert.strictEqual(pkg.dependencies.length, sampleDeps.length);
});

runTest('multiple Profiles: exactly selected Profiles in metadata', () => {
    const pkg = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' },
            { metadataType: 'Profile', metadataName: 'Admin' }
        ],
        requiredDependencies: sampleDeps
    });

    assert.strictEqual(pkg.metadata.length, 2);
    const names = pkg.metadata.map((m) => m.metadataName).sort();
    assert.deepStrictEqual(names, ['Admin', 'Sales Manager']);
});

runTest('mixed selection falls back to legacy composition', () => {
    const legacy = generateDeploymentPackage({
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' },
            { metadataType: 'ApexClass', metadataName: 'Foo' }
        ],
        requiredDependencies: sampleDeps
    });

    const withFlag = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' },
            { metadataType: 'ApexClass', metadataName: 'Foo' }
        ],
        requiredDependencies: sampleDeps
    });

    assert.deepStrictEqual(
        withFlag.metadata.map((m) => `${m.metadataType}:${m.metadataName}`),
        legacy.metadata.map((m) => `${m.metadataType}:${m.metadataName}`)
    );
});

runTest('empty selection falls back to legacy composition', () => {
    const legacy = generateDeploymentPackage({
        selectedMetadata: [],
        requiredDependencies: sampleDeps
    });

    const withFlag = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        selectedMetadata: [],
        requiredDependencies: sampleDeps
    });

    assert.deepStrictEqual(withFlag.metadata, legacy.metadata);
});

runTest('malformed Profile selection falls back to legacy', () => {
    const legacy = generateDeploymentPackage({
        selectedMetadata: [{ metadataType: 'Profile' }],
        requiredDependencies: sampleDeps
    });

    const withFlag = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        selectedMetadata: [{ metadataType: 'Profile' }],
        requiredDependencies: sampleDeps
    });

    assert.deepStrictEqual(withFlag.metadata.length, legacy.metadata.length);
    assert.ok(withFlag.metadata.length > 1);
});

runTest('duplicate Profile rows fall back to legacy composition', () => {
    const legacy = generateDeploymentPackage({
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' },
            { metadataType: 'Profile', metadataName: 'Sales Manager' }
        ],
        requiredDependencies: sampleDeps
    });

    const withFlag = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' },
            { metadataType: 'Profile', metadataName: 'Sales Manager' }
        ],
        requiredDependencies: sampleDeps
    });

    assert.deepStrictEqual(withFlag.metadata.length, legacy.metadata.length);
});

runTest('dependency graph records unchanged when minimal mode active', () => {
    const inputDeps = sampleDeps.map((d) => ({ ...d }));
    const pkg = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' }
        ],
        requiredDependencies: inputDeps
    });

    assert.deepStrictEqual(inputDeps, sampleDeps);
    assert.strictEqual(pkg.dependencies.length, sampleDeps.length);
    assert.strictEqual(pkg.dependencies[0].type, 'CustomField');
});

runTest('non-Profile selection unchanged with flag false', () => {
    const selectedMetadata = [
        { metadataType: 'ApexClass', metadataName: 'Foo' }
    ];
    const baseline = generateDeploymentPackage({
        selectedMetadata,
        requiredDependencies: sampleDeps
    });
    const explicitFalse = generateDeploymentPackage({
        profileOnlyMinimalPackage: false,
        selectedMetadata,
        requiredDependencies: sampleDeps
    });

    assert.deepStrictEqual(explicitFalse.metadata, baseline.metadata);
});

runTest('manifest contains exactly package metadata members', () => {
    const pkg = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' }
        ],
        requiredDependencies: sampleDeps
    });

    const manifest = generateManifest(pkg);
    assert.ok(manifest.packageXml.includes('<members>Sales Manager</members>'));
    assert.ok(!manifest.packageXml.includes('Account.Industry'));
    assert.strictEqual(manifest.summary.members, 1);
});

runTest('SAFE_SKIP regeneration preserves flag on deploymentPackage spread', async () => {
    const { applySafeSkips } = require('./deploymentFailureClassification/safeSkip.service');

    let capturedArgs = null;
    const stubGenerate = (args) => {
        capturedArgs = args;
        return generateDeploymentPackage(args);
    };

    await applySafeSkips(
        {
            failureClassification: {
                failures: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Industry',
                        category: 'SAFE_SKIP',
                        canSafeSkip: true,
                        canAutoFix: false,
                        reason: 'Formula type conversion is incompatible.'
                    }
                ]
            },
            generatedDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'Profile',
                        metadataName: 'Sales Manager'
                    },
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Industry'
                    }
                ],
                dependencies: sampleDeps,
                testClasses: [],
                summary: { metadataCount: 2, dependencyCount: 2 }
            },
            generatedManifest: { packageXml: '<Package/>' },
            deploymentPackage: {
                profileOnlyMinimalPackage: true,
                selectedMetadata: [
                    { metadataType: 'Profile', metadataName: 'Sales Manager' }
                ],
                requiredDependencies: sampleDeps
            },
            selectedMetadata: [
                { metadataType: 'Profile', metadataName: 'Sales Manager' },
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Industry'
                }
            ],
            resolvedDependencies: sampleDeps
        },
        {
            generateDeploymentPackage: stubGenerate,
            generateManifest: () => ({
                packageXml: '<?xml version="1.0"?><Package/>',
                summary: {}
            }),
            buildDeploymentWorkspace: async () => ({ ready: true })
        }
    );

    assert.strictEqual(capturedArgs?.profileOnlyMinimalPackage, true);
    assert.strictEqual(capturedArgs?.selectedMetadata?.length, 1);
    assert.strictEqual(
        capturedArgs?.selectedMetadata?.[0]?.metadataName,
        'Sales Manager'
    );
});

runTest('auto-fix style regeneration spread preserves profileOnlyMinimalPackage', () => {
    const deploymentPackage = {
        profileOnlyMinimalPackage: true,
        repoUrl: 'https://example.com/repo'
    };

    const regenerated = generateDeploymentPackage({
        ...deploymentPackage,
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' }
        ],
        requiredDependencies: sampleDeps
    });

    assert.strictEqual(regenerated.metadata.length, 1);
});

runTest('revalidation package retains profileOnlyMinimalPackage from base', () => {
    const {
        buildRevalidationPackage
    } = require('./deploymentFailureClassification/deploymentAutoValidation.service');

    const revalidationPackage = buildRevalidationPackage(
        {
            profileOnlyMinimalPackage: true,
            repoUrl: 'https://example.com/repo'
        },
        {
            generatedDeploymentPackage: generateDeploymentPackage({
                profileOnlyMinimalPackage: true,
                selectedMetadata: [
                    { metadataType: 'Profile', metadataName: 'Sales Manager' }
                ],
                requiredDependencies: sampleDeps
            })
        }
    );

    assert.strictEqual(revalidationPackage.profileOnlyMinimalPackage, true);
});

runTest('source Profile XML is not modified by package composition', () => {
    const profilePath = path.join(
        __dirname,
        'dependencyResolution',
        'discoverers',
        'profileRelationship.test.js'
    );
    const source = fs.readFileSync(profilePath, 'utf8');
    generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' }
        ],
        requiredDependencies: sampleDeps
    });
    assert.strictEqual(fs.readFileSync(profilePath, 'utf8'), source);
});

runTest('eligibility helper rejects non-Profile types', () => {
    assert.strictEqual(
        evaluateProfileOnlyMinimalPackageEligibility([
            { metadataType: 'ApexClass', metadataName: 'Foo' }
        ]).eligible,
        false
    );
});

runTest('origin-derived primary: explicit PRIMARY Profile and explicit non-primary Apex', () => {
    const plan = normalizeDeployableMetadata([
        {
            metadataType: 'Profile',
            metadataName: 'Sales Manager',
            origin: METADATA_ORIGINS.PRIMARY_SELECTION
        },
        {
            metadataType: 'ApexClass',
            metadataName: 'MyController',
            origin: METADATA_ORIGINS.DIRECT_DEPENDENCY
        }
    ]);

    const explicitPrimary = resolveExplicitPrimarySelectedMetadata({}, plan);

    assert.strictEqual(explicitPrimary.length, 1);
    assert.strictEqual(explicitPrimary[0].metadataName, 'Sales Manager');
});

runTest('origin-derived primary excludes untagged Apex when a non-primary origin exists', () => {
    const plan = normalizeDeployableMetadata([
        {
            metadataType: 'Profile',
            metadataName: 'Sales Manager',
            origin: METADATA_ORIGINS.PRIMARY_SELECTION
        },
        {
            metadataType: 'CustomField',
            metadataName: 'Account.Industry',
            origin: METADATA_ORIGINS.RELATIONSHIP_TARGET
        },
        {
            metadataType: 'ApexClass',
            metadataName: 'UntaggedApex'
        }
    ]);

    const explicitPrimary = resolveExplicitPrimarySelectedMetadata({}, plan);

    assert.strictEqual(explicitPrimary.length, 1);
    assert.strictEqual(explicitPrimary[0].metadataName, 'Sales Manager');

    const pkg = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        explicitPrimarySelectedMetadata: explicitPrimary,
        selectedMetadata: plan,
        requiredDependencies: sampleDeps
    });

    assert.strictEqual(pkg.metadata.length, 1);
    assert.ok(
        !pkg.metadata.some((m) => m.metadataName === 'UntaggedApex')
    );
});

runTest('416-style plan: PRIMARY Profile + dependency origins yields Profile-only minimal manifest', () => {
    const expandedPlan = [
        {
            metadataType: 'Profile',
            metadataName: 'Sales Manager',
            origin: METADATA_ORIGINS.PRIMARY_SELECTION
        },
        {
            metadataType: 'ApexClass',
            metadataName: 'MyController',
            origin: METADATA_ORIGINS.DIRECT_DEPENDENCY
        },
        {
            metadataType: 'CustomField',
            metadataName: 'Account.Industry',
            origin: METADATA_ORIGINS.RELATIONSHIP_TARGET
        }
    ];

    const explicitPrimary = resolveExplicitPrimarySelectedMetadata(
        {},
        normalizeDeployableMetadata(expandedPlan)
    );

    assert.strictEqual(explicitPrimary.length, 1);
    assert.strictEqual(explicitPrimary[0].metadataName, 'Sales Manager');

    const pkg = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        explicitPrimarySelectedMetadata: explicitPrimary,
        selectedMetadata: expandedPlan,
        requiredDependencies: sampleDeps
    });

    assert.strictEqual(pkg.metadata.length, 1);
    assert.strictEqual(pkg.metadata[0].metadataName, 'Sales Manager');
    assert.strictEqual(pkg.dependencies.length, sampleDeps.length);

    const manifest = generateManifest(pkg);
    assert.ok(manifest.packageXml.includes('<members>Sales Manager</members>'));
    assert.ok(!manifest.packageXml.includes('MyController'));
    assert.strictEqual(manifest.summary.members, 1);
});

runTest('explicit client primary selection overrides bloated selectedMetadata', () => {
    const explicitPrimary = [
        { metadataType: 'Profile', metadataName: 'Sales Manager' }
    ];

    const pkg = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        explicitPrimarySelectedMetadata: explicitPrimary,
        selectedMetadata: [
            { metadataType: 'Profile', metadataName: 'Sales Manager' },
            { metadataType: 'ApexClass', metadataName: 'Foo' },
            { metadataType: 'CustomField', metadataName: 'Account.Industry' }
        ],
        requiredDependencies: sampleDeps
    });

    assert.strictEqual(pkg.metadata.length, 1);
    assert.strictEqual(pkg.metadata[0].metadataType, 'Profile');
});

runTest('mixed explicit primary retains legacy metadata composition', () => {
    const explicitPrimary = [
        { metadataType: 'Profile', metadataName: 'Sales Manager' },
        { metadataType: 'ApexClass', metadataName: 'Foo' }
    ];

    const legacy = generateDeploymentPackage({
        selectedMetadata: explicitPrimary,
        requiredDependencies: sampleDeps
    });

    const withFlag = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        explicitPrimarySelectedMetadata: explicitPrimary,
        selectedMetadata: explicitPrimary,
        requiredDependencies: sampleDeps
    });

    assert.deepStrictEqual(
        withFlag.metadata.map((m) => `${m.metadataType}:${m.metadataName}`),
        legacy.metadata.map((m) => `${m.metadataType}:${m.metadataName}`)
    );
});

runTest('revalidation retains explicit primary and does not widen minimal manifest', () => {
    const {
        buildRevalidationPackage
    } = require('./deploymentFailureClassification/deploymentAutoValidation.service');

    const explicitPrimary = [
        { metadataType: 'Profile', metadataName: 'Sales Manager' }
    ];

    const regenerated = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        explicitPrimarySelectedMetadata: explicitPrimary,
        selectedMetadata: explicitPrimary,
        requiredDependencies: sampleDeps
    });

    const revalidationPackage = buildRevalidationPackage(
        {
            profileOnlyMinimalPackage: true,
            explicitPrimarySelectedMetadata: explicitPrimary
        },
        { generatedDeploymentPackage: regenerated }
    );

    assert.strictEqual(
        revalidationPackage.explicitPrimarySelectedMetadata.length,
        1
    );

    const secondPass = generateDeploymentPackage({
        ...revalidationPackage,
        requiredDependencies: sampleDeps
    });

    assert.strictEqual(secondPass.metadata.length, 1);
    assert.strictEqual(secondPass.metadata[0].metadataName, 'Sales Manager');
});

runTest('missing origins without client explicit preserves legacy package composition', () => {
    const plan = normalizeDeployableMetadata([
        { metadataType: 'Profile', metadataName: 'Sales Manager' },
        { metadataType: 'ApexClass', metadataName: 'Foo' }
    ]);

    const explicitPrimary = resolveExplicitPrimarySelectedMetadata({}, plan);

    assert.strictEqual(explicitPrimary.length, 2);

    const legacy = generateDeploymentPackage({
        selectedMetadata: plan,
        requiredDependencies: sampleDeps
    });

    const withFlag = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        explicitPrimarySelectedMetadata: explicitPrimary,
        selectedMetadata: plan,
        requiredDependencies: sampleDeps
    });

    assert.deepStrictEqual(
        withFlag.metadata.map((m) => `${m.metadataType}:${m.metadataName}`),
        legacy.metadata.map((m) => `${m.metadataType}:${m.metadataName}`)
    );
});

runTest('all PRIMARY_SELECTION origins without client explicit remains legacy when mixed types selected', () => {
    const mixedPrimaryOrigins = [
        {
            metadataType: 'Profile',
            metadataName: 'Sales Manager',
            origin: METADATA_ORIGINS.PRIMARY_SELECTION
        },
        {
            metadataType: 'ApexClass',
            metadataName: 'Foo',
            origin: METADATA_ORIGINS.PRIMARY_SELECTION
        }
    ];

    const explicitPrimary = resolveExplicitPrimarySelectedMetadata(
        {},
        normalizeDeployableMetadata(mixedPrimaryOrigins)
    );

    assert.strictEqual(explicitPrimary.length, 2);

    const pkg = generateDeploymentPackage({
        profileOnlyMinimalPackage: true,
        explicitPrimarySelectedMetadata: explicitPrimary,
        selectedMetadata: mixedPrimaryOrigins,
        requiredDependencies: sampleDeps
    });

    assert.ok(pkg.metadata.length > 1);
});
