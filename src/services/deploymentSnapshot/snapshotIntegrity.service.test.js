const assert = require('assert');

const {
    CHANGE_CLASS
} = require('./snapshot.types');
const {
    hashBytes,
    computeSnapshotIntegrityHash
} = require('./snapshotIntegrity.service');

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

const OLD_IMPL = Buffer.from(
    'public class AccountService {\n    // old implementation\n}\n',
    'utf8'
);
const NEW_IMPL = Buffer.from(
    'public class AccountService {\n    // new implementation\n}\n',
    'utf8'
);

runTest('same bytes produce the same SHA-256', () => {
    const left = hashBytes(OLD_IMPL);
    const right = hashBytes(Buffer.from(OLD_IMPL));

    assert.strictEqual(left, right);
    assert.match(left, /^[a-f0-9]{64}$/);
});

runTest('different bytes produce different SHA-256', () => {
    assert.notStrictEqual(hashBytes(OLD_IMPL), hashBytes(NEW_IMPL));
});

runTest('hash is over actual bytes not filenames', () => {
    const hash = hashBytes(OLD_IMPL);

    assert.notStrictEqual(hash, hashBytes(Buffer.from('AccountService.cls')));
});

runTest('hashBytes rejects strings to avoid encoding ambiguity', () => {
    assert.throws(() => hashBytes('not-bytes'), TypeError);
});

runTest('aggregate hash is independent of insertion order', () => {
    const membersA = [
        {
            metadataType: 'CustomField',
            metadataName: 'Account.Foo__c',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeHash: 'aaa'
        },
        {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeHash: 'bbb'
        }
    ];
    const membersB = [membersA[1], membersA[0]];

    assert.strictEqual(
        computeSnapshotIntegrityHash(membersA),
        computeSnapshotIntegrityHash(membersB)
    );
});

runTest('aggregate hash uses ABSENT for NEW and UNKNOWN', () => {
    const withHashes = computeSnapshotIntegrityHash([
        {
            metadataType: 'ApexClass',
            metadataName: 'BrandNew',
            changeClass: CHANGE_CLASS.NEW,
            destinationBeforeHash: null
        },
        {
            metadataType: 'ApexClass',
            metadataName: 'Maybe',
            changeClass: CHANGE_CLASS.UNKNOWN,
            destinationBeforeHash: null
        }
    ]);
    const explicit = computeSnapshotIntegrityHash([
        {
            metadataType: 'ApexClass',
            metadataName: 'BrandNew',
            changeClass: CHANGE_CLASS.NEW,
            destinationBeforeHash: 'should-be-ignored'
        },
        {
            metadataType: 'ApexClass',
            metadataName: 'Maybe',
            changeClass: CHANGE_CLASS.UNKNOWN,
            destinationBeforeHash: 'should-be-ignored'
        }
    ]);

    assert.strictEqual(withHashes, explicit);
});

runTest('changing expectedAfterHash changes schema v2 aggregate', () => {
    const base = [
        {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeHash: hashBytes(OLD_IMPL),
            expectedAfterHash: hashBytes(NEW_IMPL)
        }
    ];
    const changed = [
        {
            ...base[0],
            expectedAfterHash: hashBytes(Buffer.from('other-after'))
        }
    ];

    assert.notStrictEqual(
        computeSnapshotIntegrityHash(base, { schemaVersion: 2 }),
        computeSnapshotIntegrityHash(changed, { schemaVersion: 2 })
    );
});

runTest('schema v1 ignores expectedAfterHash', () => {
    const left = [
        {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeHash: hashBytes(OLD_IMPL),
            expectedAfterHash: 'one'
        }
    ];
    const right = [
        {
            ...left[0],
            expectedAfterHash: 'two'
        }
    ];

    assert.strictEqual(
        computeSnapshotIntegrityHash(left, { schemaVersion: 1 }),
        computeSnapshotIntegrityHash(right, { schemaVersion: 1 })
    );
});

runTest('changing a member hash changes the aggregate', () => {
    const base = [
        {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeHash: hashBytes(OLD_IMPL)
        }
    ];
    const changed = [
        {
            metadataType: 'ApexClass',
            metadataName: 'AccountService',
            changeClass: CHANGE_CLASS.MODIFIED,
            destinationBeforeHash: hashBytes(NEW_IMPL)
        }
    ];

    assert.notStrictEqual(
        computeSnapshotIntegrityHash(base),
        computeSnapshotIntegrityHash(changed)
    );
});
