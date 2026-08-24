const assert = require('assert');
const fs = require('fs');
const path = require('path');

/**
 * Architectural isolation: the snapshot foundation must not be imported by
 * the existing deployment engine. This is a static require-graph assertion,
 * not a runtime integration.
 */

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

const SRC_ROOT = path.resolve(__dirname, '../..');
const SNAPSHOT_DIR = path.resolve(__dirname);

const PROTECTED_FILES = [
    'services/deploymentValidation.service.js',
    'services/deploymentExecution.service.js',
    'services/checkOnlyDeployment.service.js',
    'services/deploymentPackage.service.js',
    'services/packageXml.service.js',
    'services/deploymentWorkspace.service.js',
    'services/deploymentPlanner/deploymentPlanner.service.js',
    'services/deploymentReview.service.js',
    'services/deploymentHistory.service.js',
    'controllers/deployment.controller.js',
    'routes/deployment.routes.js'
];

function listJsFiles(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            listJsFiles(fullPath, acc);
            continue;
        }

        if (entry.name.endsWith('.js')) {
            acc.push(fullPath);
        }
    }

    return acc;
}

function mentionsSnapshotModule(filePath) {
    const source = fs.readFileSync(filePath, 'utf8');

    return (
        source.includes('deploymentSnapshot') ||
        source.includes("services/deploymentSnapshot")
    );
}

runTest('protected deployment files do not import deploymentSnapshot', () => {
    for (const relative of PROTECTED_FILES) {
        const filePath = path.join(SRC_ROOT, relative);

        assert.ok(fs.existsSync(filePath), `missing ${relative}`);
        assert.strictEqual(
            mentionsSnapshotModule(filePath),
            false,
            `${relative} must not reference deploymentSnapshot`
        );
    }
});

runTest('no src file outside deploymentSnapshot requires the snapshot module', () => {
    const files = listJsFiles(SRC_ROOT).filter((filePath) => {
        const relative = path.relative(SNAPSHOT_DIR, filePath);

        return relative.startsWith('..');
    });

    const offenders = files.filter((filePath) => {
        const source = fs.readFileSync(filePath, 'utf8');

        return /require\((['"])[^'"]*deploymentSnapshot/.test(source);
    });

    assert.deepStrictEqual(
        offenders.map((filePath) => path.relative(SRC_ROOT, filePath)),
        []
    );
});
