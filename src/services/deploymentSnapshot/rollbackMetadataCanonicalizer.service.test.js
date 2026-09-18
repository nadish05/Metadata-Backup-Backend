'use strict';

const assert = require('assert');

const {
    CANONICALIZATION_VERSION,
    canonicalizeForRollback
} = require('./rollbackMetadataCanonicalizer.service');
const {
    packMemberFiles,
    unpackMemberFiles
} = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');

const FIELD_PATH =
    'force-app/main/default/objects/Vehicle__c/fields/Air_Conditioner__c.field-meta.xml';
const OBJECT_PATH =
    'force-app/main/default/objects/Vehicle__c/Vehicle__c.object-meta.xml';
const FIELD_NAME = 'Vehicle__c.Air_Conditioner__c';
const OBJECT_NAME = 'Vehicle__c';
const SALESFORCE_METADATA_NS = 'http://soap.sforce.com/2006/04/metadata';

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

function packFiles(files) {
    return packMemberFiles(
        files.map((file) => ({
            relativePath: file.relativePath,
            bytes: Buffer.from(file.bytes)
        }))
    );
}

function canonicalize({
    metadataType,
    metadataName,
    filePath,
    artifactBytes,
    canonicalizationVersion = CANONICALIZATION_VERSION
}) {
    return canonicalizeForRollback({
        metadataType,
        metadataName,
        filePath,
        artifactBytes,
        canonicalizationVersion
    });
}

function canonicalField(xml, options = {}) {
    return canonicalize({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: options.filePath || FIELD_PATH,
        artifactBytes: options.artifactBytes || packFiles([
            {
                relativePath: options.filePath || FIELD_PATH,
                bytes: Buffer.from(xml, 'utf8')
            }
        ])
    });
}

function canonicalObject(xml, options = {}) {
    return canonicalize({
        metadataType: 'CustomObject',
        metadataName: OBJECT_NAME,
        filePath: options.filePath || OBJECT_PATH,
        artifactBytes: options.artifactBytes || packFiles([
            {
                relativePath: options.filePath || OBJECT_PATH,
                bytes: Buffer.from(xml, 'utf8')
            }
        ])
    });
}

const fieldWithFalse = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Air_Conditioner__c</fullName>
    <deprecated>false</deprecated>
    <label>Air Conditioner</label>
</CustomField>`;

const fieldWithoutDeprecated = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Air_Conditioner__c</fullName>
    <label>Air Conditioner</label>
</CustomField>`;

const objectWithFalse = `<?xml version="1.0" encoding="UTF-8"?>
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

runTest('M1 exactly one target XML file succeeds', () => {
    const result = canonicalField(fieldWithFalse);
    assert.deepStrictEqual(result.appliedRules, [
        'CustomField.deprecated.false-omitted'
    ]);
});

runTest('M2 zero target XML files fails closed', () => {
    assert.throws(
        () =>
            canonicalize({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                artifactBytes: packFiles([
                    {
                        relativePath:
                            'force-app/main/default/objects/Vehicle__c/fields/Other__c.field-meta.xml',
                        bytes: Buffer.from(fieldWithFalse, 'utf8')
                    }
                ])
            }),
        /no artifact file|logical file path does not match|no XML member/i
    );
});

runTest('M3 multiple target XML files fails closed', () => {
    assert.throws(
        () =>
            canonicalize({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                artifactBytes: packFiles([
                    {
                        relativePath: FIELD_PATH,
                        bytes: Buffer.from(fieldWithFalse, 'utf8')
                    },
                    {
                        relativePath:
                            'backup/force-app/main/default/objects/Vehicle__c/fields/Air_Conditioner__c.field-meta.xml',
                        bytes: Buffer.from(fieldWithoutDeprecated, 'utf8')
                    }
                ])
            }),
        /multiple XML members/i
    );
});

runTest('M4 target XML plus unrelated XML only target changes', () => {
    const unrelatedPath =
        'force-app/main/default/objects/Vehicle__c/listViews/All.listView-meta.xml';
    const unrelatedXml =
        '<ListView xmlns="http://soap.sforce.com/2006/04/metadata"><deprecated>false</deprecated></ListView>';
    const artifactBytes = packFiles([
        { relativePath: FIELD_PATH, bytes: Buffer.from(fieldWithFalse, 'utf8') },
        { relativePath: unrelatedPath, bytes: Buffer.from(unrelatedXml, 'utf8') }
    ]);
    const result = canonicalize({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        artifactBytes
    });
    const files = unpackMemberFiles(result.canonicalArtifactBytes);
    const unrelated = files.find((file) => file.relativePath === unrelatedPath);

    assert.ok(unrelated);
    assert.ok(unrelated.bytes.equals(Buffer.from(unrelatedXml, 'utf8')));
    assert.notStrictEqual(
        files.find((file) => file.relativePath === FIELD_PATH).bytes.toString('utf8'),
        fieldWithFalse
    );
});

runTest('M5 unrelated XML bytes remain byte-identical', () => {
    const unrelatedPath =
        'force-app/main/default/objects/Vehicle__c/listViews/All.listView-meta.xml';
    const unrelatedBytes = Buffer.from('<!-- keep me -->\n<ListView/>', 'utf8');
    const artifactBytes = packFiles([
        { relativePath: FIELD_PATH, bytes: Buffer.from(fieldWithFalse, 'utf8') },
        { relativePath: unrelatedPath, bytes: unrelatedBytes }
    ]);
    const result = canonicalize({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        artifactBytes
    });
    const unrelated = unpackMemberFiles(result.canonicalArtifactBytes).find(
        (file) => file.relativePath === unrelatedPath
    );

    assert.ok(unrelated.bytes.equals(unrelatedBytes));
});

runTest('M6 non-XML file bytes remain byte-identical', () => {
    const binaryPath = 'force-app/main/default/classes/Helper.cls';
    const binaryBytes = Buffer.from([0x00, 0x01, 0xff, 0x62]);
    const artifactBytes = packFiles([
        { relativePath: FIELD_PATH, bytes: Buffer.from(fieldWithFalse, 'utf8') },
        { relativePath: binaryPath, bytes: binaryBytes }
    ]);
    const result = canonicalize({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        artifactBytes
    });
    const binary = unpackMemberFiles(result.canonicalArtifactBytes).find(
        (file) => file.relativePath === binaryPath
    );

    assert.ok(binary.bytes.equals(binaryBytes));
});

runTest('M7 duplicate file paths fail closed', () => {
    assert.throws(
        () =>
            canonicalize({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                artifactBytes: packFiles([
                    {
                        relativePath: FIELD_PATH,
                        bytes: Buffer.from(fieldWithFalse, 'utf8')
                    },
                    {
                        relativePath: FIELD_PATH,
                        bytes: Buffer.from(fieldWithoutDeprecated, 'utf8')
                    }
                ])
            }),
        /duplicate artifact file paths/i
    );
});

runTest('M8 one deprecated=false canonicalizes', () => {
    assert.deepStrictEqual(
        canonicalField(fieldWithFalse).appliedRules,
        ['CustomField.deprecated.false-omitted']
    );
});

runTest('M9 two deprecated=false elements fail closed', () => {
    const xml = fieldWithFalse.replace(
        '</CustomField>',
        '    <deprecated>false</deprecated>\n</CustomField>'
    );

    assert.throws(() => canonicalField(xml), /duplicate deprecated/i);
});

runTest('M10 deprecated=false plus deprecated=true fails closed', () => {
    const xml = fieldWithFalse.replace(
        '</CustomField>',
        '    <deprecated>true</deprecated>\n</CustomField>'
    );

    assert.throws(() => canonicalField(xml), /duplicate deprecated/i);
});

runTest('M11 duplicate deprecated=true fails closed', () => {
    const xml = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <deprecated>true</deprecated>\n    <deprecated>true</deprecated>\n</CustomField>'
    );

    assert.throws(() => canonicalField(xml), /duplicate deprecated/i);
});

runTest('M12 deprecated=true remains distinct', () => {
    const xml = fieldWithFalse.replace('false', 'true');
    const result = canonicalField(xml);

    assert.deepStrictEqual(result.appliedRules, []);
    assert.notStrictEqual(
        result.canonicalHash,
        canonicalField(fieldWithoutDeprecated).canonicalHash
    );
});

runTest('M13 deprecated=TRUE is not normalized', () => {
    const xml = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <deprecated>TRUE</deprecated>\n</CustomField>'
    );

    assert.throws(() => canonicalField(xml), /unsupported deprecated value/i);
});

runTest('M14 deprecated=1 is not normalized', () => {
    const xml = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <deprecated>1</deprecated>\n</CustomField>'
    );

    assert.throws(() => canonicalField(xml), /unsupported deprecated value/i);
});

runTest('M15 unexpected deprecated value fails safely', () => {
    const xml = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <deprecated>maybe</deprecated>\n</CustomField>'
    );

    assert.throws(() => canonicalField(xml), /unsupported deprecated value/i);
});

runTest('M16 mismatched tags fail', () => {
    assert.throws(
        () => canonicalField('<CustomField><deprecated>false</CustomField>'),
        /mismatched|incomplete/i
    );
});

runTest('M17 unclosed tag fails', () => {
    assert.throws(
        () =>
            canonicalField(
                '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><deprecated>false</deprecated>'
            ),
        /incomplete|unterminated/i
    );
});

runTest('M18 multiple roots fail', () => {
    const xml = `${fieldWithFalse}<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"></CustomField>`;

    assert.throws(() => canonicalField(xml), /multi-root|incomplete/i);
});

runTest('M19 malformed attribute fails', () => {
    const xml = fieldWithFalse.replace(
        'xmlns="http://soap.sforce.com/2006/04/metadata"',
        'xmlns=http://soap.sforce.com/2006/04/metadata'
    );

    assert.throws(() => canonicalField(xml), /malformed XML attribute/i);
});

runTest('M20 undeclared namespace prefix fails', () => {
    const xml = fieldWithFalse.replace(
        '<deprecated>false</deprecated>',
        '<ns:deprecated>false</ns:deprecated>'
    );

    assert.throws(() => canonicalField(xml), /undeclared XML namespace prefix/i);
});

runTest('M21 invalid XML declaration fails', () => {
    const xml = fieldWithFalse.replace(
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<?xml broken?>'
    );

    assert.throws(() => canonicalField(xml), /invalid XML declaration/i);
});

runTest('M22 wrong metadata namespace fails', () => {
    const xml = fieldWithFalse.replace(
        SALESFORCE_METADATA_NS,
        'http://example.com/wrong'
    );

    assert.throws(() => canonicalField(xml), /unsupported Salesforce metadata namespace/i);
});

runTest('M23 valid expected Salesforce XML encoding succeeds', () => {
    assert.ok(canonicalField(fieldWithFalse).canonicalArtifactBytes.length > 0);
});

runTest('M24 unsupported encoding fails closed', () => {
    const utf16 = Buffer.from([0xff, 0xfe, 0x3c, 0x00]);

    assert.throws(
        () =>
            canonicalize({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                artifactBytes: packFiles([
                    { relativePath: FIELD_PATH, bytes: utf16 }
                ])
            }),
        /UTF-16|UTF-8 encoded/i
    );
});

runTest('M25 BOM behavior is deterministic and safe', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from(fieldWithoutDeprecated, 'utf8');
    const withBom = Buffer.concat([bom, body]);
    const artifactBytes = packFiles([
        { relativePath: FIELD_PATH, bytes: withBom }
    ]);
    const result = canonicalize({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        artifactBytes
    });
    const output = unpackMemberFiles(result.canonicalArtifactBytes)[0].bytes;

    assert.ok(output.subarray(0, 3).equals(bom));
    assert.deepStrictEqual(result.appliedRules, []);
});

runTest('M26 input bytes remain unchanged', () => {
    const input = packFiles([
        { relativePath: FIELD_PATH, bytes: Buffer.from(fieldWithFalse, 'utf8') }
    ]);
    const before = Buffer.from(input);

    canonicalize({
        metadataType: 'CustomField',
        metadataName: FIELD_NAME,
        filePath: FIELD_PATH,
        artifactBytes: input
    });

    assert.ok(input.equals(before));
});

runTest('M27 CustomField type plus CustomField logical file succeeds', () => {
    assert.ok(canonicalField(fieldWithFalse).canonicalArtifactBytes);
});

runTest('M28 CustomObject type plus CustomObject logical file succeeds', () => {
    assert.ok(canonicalObject(objectWithFalse).canonicalArtifactBytes);
});

runTest('M29 CustomField type plus CustomObject file fails', () => {
    assert.throws(
        () =>
            canonicalize({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                artifactBytes: packFiles([
                    {
                        relativePath: FIELD_PATH,
                        bytes: Buffer.from(objectWithFalse, 'utf8')
                    }
                ])
            }),
        /XML root does not match CustomField|CustomField identity cannot use CustomObject XML/i
    );
});

runTest('M30 CustomObject type plus CustomField file fails', () => {
    assert.throws(
        () =>
            canonicalize({
                metadataType: 'CustomObject',
                metadataName: OBJECT_NAME,
                filePath: OBJECT_PATH,
                artifactBytes: packFiles([
                    {
                        relativePath: OBJECT_PATH,
                        bytes: Buffer.from(fieldWithFalse, 'utf8')
                    }
                ])
            }),
        /XML root does not match CustomObject|CustomObject identity cannot use CustomField XML/i
    );
});

runTest('M31 invalid metadataName/filePath fails closed', () => {
    assert.throws(
        () =>
            canonicalize({
                metadataType: 'CustomField',
                metadataName: 'InvalidName',
                filePath: FIELD_PATH,
                artifactBytes: packFiles([
                    {
                        relativePath: FIELD_PATH,
                        bytes: Buffer.from(fieldWithFalse, 'utf8')
                    }
                ])
            }),
        /Object\.Field/i
    );
});

runTest('M32 standard indented deprecated=false canonicalizes', () => {
    assert.deepStrictEqual(
        canonicalField(fieldWithFalse).appliedRules,
        ['CustomField.deprecated.false-omitted']
    );
});

runTest('M33 already omitted deprecated canonicalizes identically', () => {
    assert.ok(
        canonicalField(fieldWithFalse).canonicalArtifactBytes.equals(
            canonicalField(fieldWithoutDeprecated).canonicalArtifactBytes
        )
    );
});

runTest('M34 inline formatting does not cause unsafe broad normalization', () => {
    const xml = fieldWithoutDeprecated.replace(
        '<label>Air Conditioner</label>',
        '<label>Air Conditioner</label><deprecated>false</deprecated>'
    );
    const result = canonicalField(xml);
    const output = unpackMemberFiles(result.canonicalArtifactBytes)[0].bytes.toString(
        'utf8'
    );

    assert.deepStrictEqual(result.appliedRules, [
        'CustomField.deprecated.false-omitted'
    ]);
    assert.ok(output.includes('<label>Air Conditioner</label>'));
    assert.ok(!output.includes('<deprecated>false</deprecated>'));
});

runTest('M35 unrelated whitespace remains unchanged', () => {
    const spaced = fieldWithoutDeprecated.replace(
        '<label>Air Conditioner</label>',
        '<label>Air   Conditioner</label>'
    );
    const result = canonicalField(spaced);
    const output = unpackMemberFiles(result.canonicalArtifactBytes)[0].bytes.toString(
        'utf8'
    );

    assert.ok(output.includes('<label>Air   Conditioner</label>'));
});

runTest('M36 deprecated normalization plus changed label remains different', () => {
    assert.notStrictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(
            fieldWithoutDeprecated.replace('Air Conditioner', 'Different Label')
        ).canonicalHash
    );
});

runTest('M37 deprecated normalization plus changed type remains different', () => {
    const changed = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <type>Number</type>\n</CustomField>'
    );

    assert.notStrictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(changed).canonicalHash
    );
});

runTest('M38 deprecated normalization plus changed fullName remains different', () => {
    const changed = fieldWithoutDeprecated.replace(
        'Air_Conditioner__c',
        'Other_Field__c'
    );

    assert.notStrictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(changed).canonicalHash
    );
});

runTest('M39 deprecated normalization plus changed relationship remains different', () => {
    const changed = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <referenceTo>Account</referenceTo>\n</CustomField>'
    );

    assert.notStrictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(changed).canonicalHash
    );
});

runTest('M40 deprecated normalization plus changed required remains different', () => {
    const changed = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <required>true</required>\n</CustomField>'
    );

    assert.notStrictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(changed).canonicalHash
    );
});

runTest('M41 deprecated normalization plus changed trackHistory remains different', () => {
    const changed = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <trackHistory>true</trackHistory>\n</CustomField>'
    );

    assert.notStrictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(changed).canonicalHash
    );
});

runTest('M42 deprecated normalization plus changed trackTrending remains different', () => {
    const changed = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <trackTrending>true</trackTrending>\n</CustomField>'
    );

    assert.notStrictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(changed).canonicalHash
    );
});

runTest('M43 deprecated normalization plus changed defaultValue remains different', () => {
    const changed = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <defaultValue>0</defaultValue>\n</CustomField>'
    );

    assert.notStrictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(changed).canonicalHash
    );
});

for (const [metadataType, xml, path] of [
    [
        'ListView',
        '<ListView xmlns="http://soap.sforce.com/2006/04/metadata"><deprecated>false</deprecated></ListView>',
        'force-app/main/default/objects/Vehicle__c/listViews/All.listView-meta.xml'
    ],
    [
        'ApexClass',
        'public class Demo {}',
        'force-app/main/default/classes/Demo.cls'
    ],
    [
        'ApexTrigger',
        'trigger Demo on Account (before insert) {}',
        'force-app/main/default/triggers/Demo.trigger'
    ],
    [
        'CustomMetadata',
        '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"><deprecated>false</deprecated></CustomMetadata>',
        'force-app/main/default/customMetadata/Demo__mdt.Demo.md-meta.xml'
    ],
    [
        'LightningComponentBundle',
        '<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><deprecated>false</deprecated></LightningComponentBundle>',
        'force-app/main/default/lwc/demo/demo.js-meta.xml'
    ]
]) {
    runTest(`unsupported ${metadataType} unchanged`, () => {
        const artifactBytes = packFiles([
            { relativePath: path, bytes: Buffer.from(xml, 'utf8') }
        ]);
        const result = canonicalize({
            metadataType,
            metadataName: 'Example',
            filePath: path,
            artifactBytes
        });

        assert.ok(result.canonicalArtifactBytes.equals(artifactBytes));
        assert.deepStrictEqual(result.appliedRules, []);
        assert.strictEqual(result.canonicalizationVersion, null);
    });
}

runTest('M49 CANONICAL_V1 succeeds', () => {
    assert.strictEqual(
        canonicalField(fieldWithFalse).canonicalizationVersion,
        CANONICALIZATION_VERSION
    );
});

runTest('M50 unknown version fails', () => {
    assert.throws(
        () =>
            canonicalize({
                metadataType: 'CustomField',
                metadataName: FIELD_NAME,
                filePath: FIELD_PATH,
                artifactBytes: packFiles([
                    {
                        relativePath: FIELD_PATH,
                        bytes: Buffer.from(fieldWithFalse, 'utf8')
                    }
                ]),
                canonicalizationVersion: 'CANONICAL_UNKNOWN'
            }),
        /Unsupported rollback canonicalization version/
    );
});

for (const [label, version] of [
    ['M51 missing version', undefined],
    ['M52 null version', null],
    ['M53 empty version', ''],
    ['M54 whitespace version', '   ']
]) {
    runTest(`${label} fails`, () => {
        assert.throws(
            () =>
                canonicalizeForRollback({
                    metadataType: 'CustomField',
                    metadataName: FIELD_NAME,
                    filePath: FIELD_PATH,
                    artifactBytes: packFiles([
                        {
                            relativePath: FIELD_PATH,
                            bytes: Buffer.from(fieldWithFalse, 'utf8')
                        }
                    ]),
                    canonicalizationVersion: version
                }),
            /Unsupported rollback canonicalization version/
        );
    });
}

runTest('M55 same input twice produces identical canonical bytes', () => {
    assert.ok(
        canonicalField(fieldWithFalse).canonicalArtifactBytes.equals(
            canonicalField(fieldWithFalse).canonicalArtifactBytes
        )
    );
});

runTest('M56 same input twice produces identical canonical hash', () => {
    assert.strictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(fieldWithFalse).canonicalHash
    );
});

runTest('hash equivalence raw differs but canonical hash matches', () => {
    const rawA = packFiles([
        { relativePath: FIELD_PATH, bytes: Buffer.from(fieldWithFalse, 'utf8') }
    ]);
    const rawB = packFiles([
        {
            relativePath: FIELD_PATH,
            bytes: Buffer.from(fieldWithoutDeprecated, 'utf8')
        }
    ]);

    assert.notStrictEqual(hashBytes(rawA), hashBytes(rawB));
    assert.strictEqual(
        canonicalField(fieldWithFalse).canonicalHash,
        canonicalField(fieldWithoutDeprecated).canonicalHash
    );
});

runTest('invalid metadata type fails safely', () => {
    assert.throws(
        () =>
            canonicalizeForRollback({
                metadataType: null,
                artifactBytes: packFiles([
                    {
                        relativePath: FIELD_PATH,
                        bytes: Buffer.from(fieldWithFalse, 'utf8')
                    }
                ]),
                canonicalizationVersion: CANONICALIZATION_VERSION
            }),
        /metadata type/i
    );
});

runTest('CustomObject false and omitted produce identical bytes', () => {
    assert.ok(
        canonicalObject(objectWithFalse).canonicalArtifactBytes.equals(
            canonicalObject(objectWithoutDeprecated).canonicalArtifactBytes
        )
    );
});

runTest('preserves CustomField required=false', () => {
    const xml = fieldWithoutDeprecated.replace(
        '</CustomField>',
        '    <required>false</required>\n</CustomField>'
    );
    const output = unpackMemberFiles(
        canonicalField(xml).canonicalArtifactBytes
    )[0].bytes.toString('utf8');

    assert.ok(output.includes('<required>false</required>'));
});

