'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    collectExpectedAfterArtifact
} = require('./expectedAfterArtifact.service');
const {
    CANONICALIZATION_VERSION,
    canonicalizeForRollback
} = require('./rollbackMetadataCanonicalizer.service');
const {
    packMemberFiles
} = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    DRIFT_CLASSIFICATION,
    compareMemberExpectedAfterDrift,
    resolveExpectedAfterRepresentation
} = require('./snapshotDriftComparison.service');
const {
    EXPECTED_AFTER_REPRESENTATION
} = require('./snapshot.types');
const {
    assertSalesforceCanonicalRepresentationSupported
} = require('../controlPlane/controlPlane.snapshotMapping');
const {
    CONTROL_PLANE_ERROR_CODE,
    ControlPlaneError
} = require('../controlPlane/controlPlane.errors');

const FIELD_PATH =
    'force-app/main/default/objects/Vehicle__c/fields/Air_Conditioner__c.field-meta.xml';
const OBJECT_PATH =
    'force-app/main/default/objects/Vehicle__c/Vehicle__c.object-meta.xml';
const FIELD_NAME = 'Vehicle__c.Air_Conditioner__c';
const OBJECT_NAME = 'Vehicle__c';

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

function packXml(relativePath, xml) {
    return packMemberFiles([
        {
            relativePath,
            bytes: Buffer.from(xml, 'utf8')
        }
    ]);
}

const fieldWithDeprecatedFalse = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Air_Conditioner__c</fullName>
    <defaultValue>false</defaultValue>
    <deprecated>false</deprecated>
    <label>Air Conditioner</label>
    <trackHistory>false</trackHistory>
    <trackTrending>false</trackTrending>
    <type>Checkbox</type>
</CustomField>`;

const fieldWithoutDeprecated = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Air_Conditioner__c</fullName>
    <defaultValue>false</defaultValue>
    <label>Air Conditioner</label>
    <trackHistory>false</trackHistory>
    <trackTrending>false</trackTrending>
    <type>Checkbox</type>
</CustomField>`;

const objectWithDeprecatedFalse = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Vehicle__c</fullName>
    <deprecated>false</deprecated>
    <deploymentStatus>Deployed</deploymentStatus>
</CustomObject>`;

const objectWithoutDeprecated = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Vehicle__c</fullName>
    <deploymentStatus>Deployed</deploymentStatus>
</CustomObject>`;

function canonicalHash(metadataType, metadataName, filePath, xml) {
    return canonicalizeForRollback({
        metadataType,
        metadataName,
        filePath,
        artifactBytes: packXml(filePath, xml),
        canonicalizationVersion: CANONICALIZATION_VERSION
    }).canonicalHash;
}

(async () => {
    await runTest(
        'A. CustomField deprecated=false canonicalization matches omitted destination',
        async () => {
            const rawB = packXml(FIELD_PATH, fieldWithDeprecatedFalse);
            const rawC = packXml(FIELD_PATH, fieldWithoutDeprecated);
            const canonicalB = canonicalHash(
                'CustomField',
                FIELD_NAME,
                FIELD_PATH,
                fieldWithDeprecatedFalse
            );

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: hashBytes(rawB),
                expectedAfterHash: hashBytes(rawB),
                canonicalExpectedAfterHash: canonicalB,
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(rawC),
                currentDestinationArtifactBytes: rawC
            });

            assert.strictEqual(
                result.classification,
                DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
            );
            assert.strictEqual(
                result.comparisonMode,
                EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
            );
        }
    );

    await runTest(
        'B. CustomObject deprecated=false canonicalization matches omitted destination',
        async () => {
            const rawB = packXml(OBJECT_PATH, objectWithDeprecatedFalse);
            const rawC = packXml(OBJECT_PATH, objectWithoutDeprecated);
            const canonicalB = canonicalHash(
                'CustomObject',
                OBJECT_NAME,
                OBJECT_PATH,
                objectWithDeprecatedFalse
            );

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomObject',
                metadataName: OBJECT_NAME,
                filePath: OBJECT_PATH,
                destinationBeforeHash: hashBytes(rawB),
                expectedAfterHash: hashBytes(rawB),
                canonicalExpectedAfterHash: canonicalB,
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(rawC),
                currentDestinationArtifactBytes: rawC
            });

            assert.strictEqual(
                result.classification,
                DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
            );
        }
    );

    await runTest(
        'C. Raw hashes already match without canonical comparison',
        async () => {
            const raw = packXml(FIELD_PATH, fieldWithoutDeprecated);

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: 'before-hash',
                expectedAfterHash: hashBytes(raw),
                canonicalExpectedAfterHash: 'unused',
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(raw),
                currentDestinationArtifactBytes: raw
            });

            assert.strictEqual(
                result.classification,
                DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
            );
            assert.strictEqual(
                result.comparisonMode,
                EXPECTED_AFTER_REPRESENTATION.RAW
            );
        }
    );

    await runTest(
        'D. deprecated=true vs omitted remains DRIFTED',
        async () => {
            const fieldDeprecatedTrue = fieldWithDeprecatedFalse.replace(
                '<deprecated>false</deprecated>',
                '<deprecated>true</deprecated>'
            );
            const rawB = packXml(FIELD_PATH, fieldDeprecatedTrue);
            const rawC = packXml(FIELD_PATH, fieldWithoutDeprecated);
            const canonicalB = canonicalHash(
                'CustomField',
                FIELD_NAME,
                FIELD_PATH,
                fieldDeprecatedTrue
            );

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: 'before-hash',
                expectedAfterHash: hashBytes(rawB),
                canonicalExpectedAfterHash: canonicalB,
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(rawC),
                currentDestinationArtifactBytes: rawC
            });

            assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
        }
    );

    await runTest(
        'E. trackHistory=false vs omitted remains DRIFTED',
        async () => {
            const withTrackHistory = fieldWithoutDeprecated.replace(
                '<label>Air Conditioner</label>',
                '<label>Air Conditioner</label>\n    <trackHistory>false</trackHistory>'
            );
            const rawB = packXml(FIELD_PATH, withTrackHistory);
            const rawC = packXml(FIELD_PATH, fieldWithoutDeprecated);
            const canonicalB = canonicalHash(
                'CustomField',
                FIELD_NAME,
                FIELD_PATH,
                withTrackHistory
            );

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: 'before-hash',
                expectedAfterHash: hashBytes(rawB),
                canonicalExpectedAfterHash: canonicalB,
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(rawC),
                currentDestinationArtifactBytes: rawC
            });

            assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
        }
    );

    await runTest(
        'F. required=false vs omitted remains DRIFTED',
        async () => {
            const withRequired = fieldWithoutDeprecated.replace(
                '<label>Air Conditioner</label>',
                '<label>Air Conditioner</label>\n    <required>false</required>'
            );
            const rawB = packXml(FIELD_PATH, withRequired);
            const rawC = packXml(FIELD_PATH, fieldWithoutDeprecated);
            const canonicalB = canonicalHash(
                'CustomField',
                FIELD_NAME,
                FIELD_PATH,
                withRequired
            );

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: 'before-hash',
                expectedAfterHash: hashBytes(rawB),
                canonicalExpectedAfterHash: canonicalB,
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(rawC),
                currentDestinationArtifactBytes: rawC
            });

            assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
        }
    );

    await runTest(
        'G. trackTrending=false vs omitted remains DRIFTED',
        async () => {
            const withTrackTrending = fieldWithoutDeprecated.replace(
                '<trackHistory>false</trackHistory>',
                '<trackHistory>false</trackHistory>\n    <trackTrending>false</trackTrending>'
            );
            const rawB = packXml(FIELD_PATH, withTrackTrending);
            const rawC = packXml(FIELD_PATH, fieldWithoutDeprecated);
            const canonicalB = canonicalHash(
                'CustomField',
                FIELD_NAME,
                FIELD_PATH,
                withTrackTrending
            );

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: 'before-hash',
                expectedAfterHash: hashBytes(rawB),
                canonicalExpectedAfterHash: canonicalB,
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(rawC),
                currentDestinationArtifactBytes: rawC
            });

            assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
        }
    );

    await runTest(
        'H. defaultValue=false vs omitted remains DRIFTED',
        async () => {
            const withoutDefaultValue = fieldWithoutDeprecated.replace(
                '<defaultValue>false</defaultValue>\n    ',
                ''
            );
            const rawB = packXml(FIELD_PATH, fieldWithoutDeprecated);
            const rawC = packXml(FIELD_PATH, withoutDefaultValue);
            const canonicalB = canonicalHash(
                'CustomField',
                FIELD_NAME,
                FIELD_PATH,
                fieldWithoutDeprecated
            );

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: 'before-hash',
                expectedAfterHash: hashBytes(rawB),
                canonicalExpectedAfterHash: canonicalB,
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(rawC),
                currentDestinationArtifactBytes: rawC
            });

            assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
        }
    );

    await runTest('I. Legacy snapshot without representation uses RAW behavior', async () => {
        const raw = packXml(FIELD_PATH, fieldWithDeprecatedFalse);
        const rawOther = packXml(FIELD_PATH, fieldWithoutDeprecated);

        const result = compareMemberExpectedAfterDrift({
            metadataType: 'CustomField',
            metadataName: FIELD_NAME,
            filePath: FIELD_PATH,
            destinationBeforeHash: 'before-hash',
            expectedAfterHash: hashBytes(raw),
            currentDestinationHash: hashBytes(rawOther),
            currentDestinationArtifactBytes: rawOther
        });

        assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.DRIFTED);
        assert.strictEqual(
            result.comparisonMode,
            EXPECTED_AFTER_REPRESENTATION.RAW
        );
    });

    await runTest('J. Canonical snapshot uses canonical comparison', async () => {
        const rawB = packXml(FIELD_PATH, fieldWithDeprecatedFalse);
        const rawC = packXml(FIELD_PATH, fieldWithoutDeprecated);
        const canonicalB = canonicalHash(
            'CustomField',
            FIELD_NAME,
            FIELD_PATH,
            fieldWithDeprecatedFalse
        );

        const result = compareMemberExpectedAfterDrift({
            metadataType: 'CustomField',
            metadataName: FIELD_NAME,
            filePath: FIELD_PATH,
            destinationBeforeHash: 'before-hash',
            expectedAfterHash: hashBytes(rawB),
            canonicalExpectedAfterHash: canonicalB,
            expectedAfterRepresentation:
                EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            currentDestinationHash: hashBytes(rawC),
            currentDestinationArtifactBytes: rawC
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
        assert.strictEqual(
            result.comparisonMode,
            EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
        );
    });

    await runTest('K. Unknown representation fails closed', async () => {
        const result = compareMemberExpectedAfterDrift({
            metadataType: 'CustomField',
            metadataName: FIELD_NAME,
            filePath: FIELD_PATH,
            destinationBeforeHash: 'before-hash',
            expectedAfterHash: 'hash-b',
            canonicalExpectedAfterHash: 'hash-canonical-b',
            expectedAfterRepresentation: 'CANONICAL_V2',
            currentDestinationHash: 'hash-c',
            currentDestinationArtifactBytes: Buffer.from('xml')
        });

        assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.UNKNOWN);
        assert.strictEqual(result.failClosed, true);
    });

    await runTest('L. Canonicalizer failure fails closed', async () => {
        const result = compareMemberExpectedAfterDrift({
            metadataType: 'CustomField',
            metadataName: FIELD_NAME,
            filePath: FIELD_PATH,
            destinationBeforeHash: 'before-hash',
            expectedAfterHash: 'hash-b',
            canonicalExpectedAfterHash: 'hash-canonical-b',
            expectedAfterRepresentation:
                EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            currentDestinationHash: 'hash-c',
            currentDestinationArtifactBytes: Buffer.from('<broken')
        });

        assert.strictEqual(result.classification, DRIFT_CLASSIFICATION.UNKNOWN);
        assert.strictEqual(result.failClosed, true);
        assert.strictEqual(result.failClosedReason, 'CANONICALIZATION_FAILED');
    });

    await runTest('M. ApexClass regression remains byte-for-byte RAW only', async () => {
        const apexPath = 'force-app/main/default/classes/AccountService.cls';
        const bytes = Buffer.from('public class AccountService {}');
        const hash = hashBytes(
            packMemberFiles([{ relativePath: apexPath, bytes }])
        );

        const result = compareMemberExpectedAfterDrift({
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            filePath: apexPath,
            destinationBeforeHash: 'before',
            expectedAfterHash: hash,
            expectedAfterRepresentation: EXPECTED_AFTER_REPRESENTATION.RAW,
            currentDestinationHash: hash,
            currentDestinationArtifactBytes: packMemberFiles([
                { relativePath: apexPath, bytes }
            ])
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });

    await runTest('N. ListView regression remains byte-for-byte RAW only', async () => {
        const listViewPath =
            'force-app/main/default/objects/Account/listViews/All.listView-meta.xml';
        const bytes = Buffer.from('<ListView/>');
        const packed = packMemberFiles([
            { relativePath: listViewPath, bytes }
        ]);

        const result = compareMemberExpectedAfterDrift({
            metadataType: 'ListView',
            metadataName: 'Account.All',
            filePath: listViewPath,
            destinationBeforeHash: 'before',
            expectedAfterHash: hashBytes(packed),
            currentDestinationHash: hashBytes(packed),
            currentDestinationArtifactBytes: packed
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });

    await runTest('O. DELETE rollback canonical comparison matches', async () => {
        const rawB = packXml(FIELD_PATH, fieldWithDeprecatedFalse);
        const rawC = packXml(FIELD_PATH, fieldWithoutDeprecated);
        const canonicalB = canonicalHash(
            'CustomField',
            FIELD_NAME,
            FIELD_PATH,
            fieldWithDeprecatedFalse
        );

        const result = compareMemberExpectedAfterDrift({
            metadataType: 'CustomField',
            metadataName: FIELD_NAME,
            filePath: FIELD_PATH,
            expectedAfterHash: hashBytes(rawB),
            canonicalExpectedAfterHash: canonicalB,
            expectedAfterRepresentation:
                EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            currentDestinationHash: hashBytes(rawC),
            currentDestinationArtifactBytes: rawC,
            isDeleteRollback: true
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });

    await runTest(
        'P. MODIFIED rollback preserves UNCHANGED_FROM_BEFORE before canonical',
        async () => {
            const beforeHash = 'same-as-destination';

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: beforeHash,
                expectedAfterHash: 'different-expected-after',
                canonicalExpectedAfterHash: 'canonical-b',
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: beforeHash,
                currentDestinationArtifactBytes: packXml(
                    FIELD_PATH,
                    fieldWithoutDeprecated
                )
            });

            assert.strictEqual(
                result.classification,
                DRIFT_CLASSIFICATION.UNCHANGED_FROM_BEFORE
            );
        }
    );

    await runTest('Q. MIXED rollback members keep per-member representation', async () => {
        const rawFieldB = packXml(FIELD_PATH, fieldWithDeprecatedFalse);
        const rawFieldC = packXml(FIELD_PATH, fieldWithoutDeprecated);
        const canonicalFieldB = canonicalHash(
            'CustomField',
            FIELD_NAME,
            FIELD_PATH,
            fieldWithDeprecatedFalse
        );
        const apexPath = 'force-app/main/default/classes/Mixed.cls';
        const apexBytes = Buffer.from('public class Mixed {}');
        const apexPacked = packMemberFiles([
            { relativePath: apexPath, bytes: apexBytes }
        ]);
        const apexHash = hashBytes(apexPacked);

        const canonicalMember = compareMemberExpectedAfterDrift({
            metadataType: 'CustomField',
            metadataName: FIELD_NAME,
            filePath: FIELD_PATH,
            destinationBeforeHash: 'before-field',
            expectedAfterHash: hashBytes(rawFieldB),
            canonicalExpectedAfterHash: canonicalFieldB,
            expectedAfterRepresentation:
                EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            currentDestinationHash: hashBytes(rawFieldC),
            currentDestinationArtifactBytes: rawFieldC
        });
        const rawMember = compareMemberExpectedAfterDrift({
            metadataType: 'ApexClass',
            metadataName: 'Mixed',
            filePath: apexPath,
            destinationBeforeHash: 'before-apex',
            expectedAfterHash: apexHash,
            currentDestinationHash: apexHash,
            currentDestinationArtifactBytes: apexPacked
        });

        assert.strictEqual(
            canonicalMember.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
        assert.strictEqual(
            rawMember.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });

    await runTest('R. Multi-file artifact isolates canonicalization to target XML', async () => {
        const unrelatedPath =
            'force-app/main/default/objects/Vehicle__c/listViews/All.listView-meta.xml';
        const unrelatedXml =
            '<ListView xmlns="http://soap.sforce.com/2006/04/metadata"><deprecated>false</deprecated></ListView>';
        const artifactB = packMemberFiles([
            {
                relativePath: FIELD_PATH,
                bytes: Buffer.from(fieldWithDeprecatedFalse, 'utf8')
            },
            {
                relativePath: unrelatedPath,
                bytes: Buffer.from(unrelatedXml, 'utf8')
            }
        ]);
        const artifactC = packMemberFiles([
            {
                relativePath: FIELD_PATH,
                bytes: Buffer.from(fieldWithoutDeprecated, 'utf8')
            },
            {
                relativePath: unrelatedPath,
                bytes: Buffer.from(unrelatedXml, 'utf8')
            }
        ]);
        const canonicalB = canonicalizeForRollback({
            metadataType: 'CustomField',
            metadataName: FIELD_NAME,
            filePath: FIELD_PATH,
            artifactBytes: artifactB,
            canonicalizationVersion: CANONICALIZATION_VERSION
        }).canonicalHash;

        const result = compareMemberExpectedAfterDrift({
            metadataType: 'CustomField',
            metadataName: FIELD_NAME,
            filePath: FIELD_PATH,
            destinationBeforeHash: hashBytes(artifactB),
            expectedAfterHash: hashBytes(artifactB),
            canonicalExpectedAfterHash: canonicalB,
            expectedAfterRepresentation:
                EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
            currentDestinationHash: hashBytes(artifactC),
            currentDestinationArtifactBytes: artifactC
        });

        assert.strictEqual(
            result.classification,
            DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
        );
    });

    await runTest(
        'S. Canonicalized CustomObject does not normalize child metadata',
        async () => {
            const childFieldPath =
                'force-app/main/default/objects/Vehicle__c/fields/Child__c.field-meta.xml';
            const childFieldXml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Child__c</fullName>
    <deprecated>false</deprecated>
</CustomField>`;
            const artifactB = packMemberFiles([
                {
                    relativePath: OBJECT_PATH,
                    bytes: Buffer.from(objectWithDeprecatedFalse, 'utf8')
                },
                {
                    relativePath: childFieldPath,
                    bytes: Buffer.from(childFieldXml, 'utf8')
                }
            ]);
            const artifactC = packMemberFiles([
                {
                    relativePath: OBJECT_PATH,
                    bytes: Buffer.from(objectWithoutDeprecated, 'utf8')
                },
                {
                    relativePath: childFieldPath,
                    bytes: Buffer.from(childFieldXml, 'utf8')
                }
            ]);
            const canonicalB = canonicalizeForRollback({
                metadataType: 'CustomObject',
                metadataName: OBJECT_NAME,
                filePath: OBJECT_PATH,
                artifactBytes: artifactB,
                canonicalizationVersion: CANONICALIZATION_VERSION
            }).canonicalHash;

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomObject',
                metadataName: OBJECT_NAME,
                filePath: OBJECT_PATH,
                destinationBeforeHash: hashBytes(artifactB),
                expectedAfterHash: hashBytes(artifactB),
                canonicalExpectedAfterHash: canonicalB,
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(artifactC),
                currentDestinationArtifactBytes: artifactC
            });

            assert.strictEqual(
                result.classification,
                DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
            );
        }
    );

    await runTest(
        'T. Raw hash equality still produces immediate success',
        async () => {
            const raw = packXml(FIELD_PATH, fieldWithDeprecatedFalse);

            const result = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: 'before',
                expectedAfterHash: hashBytes(raw),
                canonicalExpectedAfterHash: 'unused',
                expectedAfterRepresentation:
                    EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                currentDestinationHash: hashBytes(raw),
                currentDestinationArtifactBytes: raw
            });

            assert.strictEqual(
                result.classification,
                DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
            );
            assert.strictEqual(
                result.comparisonMode,
                EXPECTED_AFTER_REPRESENTATION.RAW
            );
        }
    );

    await runTest(
        'Integration: workspace expected-after canonical hash matches destination canonical hash',
        async () => {
            const root = fs.mkdtempSync(
                path.join(os.tmpdir(), 'p0r2a-expected-after-')
            );

            await fs.promises.mkdir(path.dirname(path.join(root, FIELD_PATH)), {
                recursive: true
            });
            await fs.promises.writeFile(
                path.join(root, FIELD_PATH),
                fieldWithDeprecatedFalse,
                'utf8'
            );

            const expectedAfter = await collectExpectedAfterArtifact({
                workspacePath: root,
                member: {
                    metadataType: 'CustomField',
                    metadataName: FIELD_NAME,
                    filePath: FIELD_PATH
                }
            });

            assert.strictEqual(
                expectedAfter.expectedAfterRepresentation,
                EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1
            );
            assert.ok(expectedAfter.canonicalExpectedAfterHash);
            assert.notStrictEqual(
                expectedAfter.expectedAfterHash,
                expectedAfter.canonicalExpectedAfterHash
            );

            const destinationBytes = packXml(FIELD_PATH, fieldWithoutDeprecated);
            const destinationCanonical = canonicalizeForRollback({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                artifactBytes: destinationBytes,
                canonicalizationVersion: CANONICALIZATION_VERSION
            }).canonicalHash;

            const comparison = compareMemberExpectedAfterDrift({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                destinationBeforeHash: 'before-hash',
                expectedAfterHash: expectedAfter.expectedAfterHash,
                canonicalExpectedAfterHash:
                    expectedAfter.canonicalExpectedAfterHash,
                expectedAfterRepresentation:
                    expectedAfter.expectedAfterRepresentation,
                currentDestinationHash: hashBytes(destinationBytes),
                currentDestinationArtifactBytes: destinationBytes
            });

            assert.strictEqual(
                comparison.classification,
                DRIFT_CLASSIFICATION.MATCHES_EXPECTED_AFTER
            );
            assert.strictEqual(
                destinationCanonical,
                expectedAfter.canonicalExpectedAfterHash
            );

            await fs.promises.rm(root, { recursive: true, force: true });
        }
    );

    await runTest(
        'Salesforce control-plane persistence blocks CANONICAL_V1 without schema',
        async () => {
            assert.throws(
                () =>
                    assertSalesforceCanonicalRepresentationSupported({
                        metadataType: 'CustomField',
                        metadataName: FIELD_NAME,
                        expectedAfterRepresentation:
                            EXPECTED_AFTER_REPRESENTATION.CANONICAL_V1,
                        canonicalExpectedAfterHash: 'abc123'
                    }),
                (error) =>
                    error instanceof ControlPlaneError &&
                    error.code === CONTROL_PLANE_ERROR_CODE.CONTROL_PLANE_SCHEMA_MISMATCH
            );
        }
    );

    await runTest('resolveExpectedAfterRepresentation treats missing as RAW', async () => {
        assert.strictEqual(
            resolveExpectedAfterRepresentation(undefined),
            EXPECTED_AFTER_REPRESENTATION.RAW
        );
        assert.strictEqual(
            resolveExpectedAfterRepresentation(null),
            EXPECTED_AFTER_REPRESENTATION.RAW
        );
    });
})();
