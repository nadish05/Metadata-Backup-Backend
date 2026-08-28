'use strict';

const assert = require('assert');

const {
    createDeploymentHistoryService
} = require('./deploymentHistory.service');
const {
    createMemoryDeploymentHistoryStore
} = require('./deploymentHistoryStores/memoryDeploymentHistoryStore');

const SAFE_STORAGE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const HISTORY_ID_PATTERN = /^history_(\d{8})_(\d{3})_([a-f0-9]{8})$/;

const basePackage = {
    repoUrl: 'https://github.com/example/repo.git',
    sourceBranch: 'feature/a',
    destinationBranch: 'main'
};

const readyReadiness = {
    overallStatus: 'READY',
    canDeploy: true,
    blockingIssues: [],
    warnings: [],
    summary: {
        destinationConnectivity: 'PASS',
        metadataValidation: 'PASS',
        dependencyValidation: 'PASS'
    }
};

function formatDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}${month}${day}`;
}

function createHistoryId(service) {
    return service.createHistory({
        deploymentPackage: basePackage,
        deploymentReadiness: readyReadiness
    });
}

function assertHistoryIdFormat(historyId) {
    assert.ok(historyId, 'historyId is required');
    assert.ok(historyId.startsWith('history_'), 'historyId must start with history_');
    assert.ok(historyId.length <= 80, 'historyId must fit Backend_History_Id__c');
    assert.ok(
        SAFE_STORAGE_KEY_PATTERN.test(historyId),
        'historyId must satisfy storage-key validation'
    );

    const match = historyId.match(HISTORY_ID_PATTERN);

    assert.ok(match, 'historyId must match history_YYYYMMDD_NNN_entropy format');
    assert.strictEqual(match[1], formatDateKey(), 'historyId must include current date prefix');
}

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

runTest('simulated restart: fresh service instance produces a different history id', () => {
    const storeA = createMemoryDeploymentHistoryStore();
    const storeB = createMemoryDeploymentHistoryStore();
    const serviceA = createDeploymentHistoryService({ store: storeA });
    const serviceB = createDeploymentHistoryService({ store: storeB });

    const firstId = createHistoryId(serviceA);
    const secondId = createHistoryId(serviceB);

    assertHistoryIdFormat(firstId);
    assertHistoryIdFormat(secondId);
    assert.notStrictEqual(firstId, secondId);
});

runTest('simulated replica: independent service instances produce different history ids', () => {
    const serviceA = createDeploymentHistoryService({
        store: createMemoryDeploymentHistoryStore()
    });
    const serviceB = createDeploymentHistoryService({
        store: createMemoryDeploymentHistoryStore()
    });

    const idA = createHistoryId(serviceA);
    const idB = createHistoryId(serviceB);

    assertHistoryIdFormat(idA);
    assertHistoryIdFormat(idB);
    assert.notStrictEqual(idA, idB);
});

runTest('same-process multiple history creations produce unique history ids', () => {
    const service = createDeploymentHistoryService({
        store: createMemoryDeploymentHistoryStore()
    });
    const ids = new Set();

    for (let index = 0; index < 20; index += 1) {
        const historyId = createHistoryId(service);

        assertHistoryIdFormat(historyId);
        assert.strictEqual(ids.has(historyId), false);
        ids.add(historyId);
    }
});

if (process.exitCode) {
    console.error('Deployment history id generation tests failed.');
} else {
    console.log('Deployment history id generation tests passed.');
}
