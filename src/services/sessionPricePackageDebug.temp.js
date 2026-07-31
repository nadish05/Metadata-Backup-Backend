/**
 * TEMPORARY DEBUG — Session__c.Price__c package/workspace lifecycle tracing.
 * Remove after investigation. Logging only; no business logic.
 */

const SESSION_PRICE_NAME = 'Session__c.Price__c';
const SESSION_PRICE_TYPE = 'CustomField';

function getTopStack(frameCount = 6) {
    const stack = new Error().stack || '';

    return (
        stack
            .split('\n')
            .slice(2, 2 + frameCount)
            .map((line) => line.trim())
            .join('\n') || 'n/a'
    );
}

function getItemType(item) {
    return item?.type || item?.metadataType || null;
}

function getItemName(item) {
    return item?.name || item?.metadataName || null;
}

function isSessionPrice(item) {
    return (
        getItemType(item) === SESSION_PRICE_TYPE &&
        getItemName(item) === SESSION_PRICE_NAME
    );
}

function findSessionPriceIndexes(collection) {
    if (!Array.isArray(collection)) {
        return [];
    }

    const indexes = [];

    for (let i = 0; i < collection.length; i += 1) {
        if (isSessionPrice(collection[i])) {
            indexes.push(i);
        }
    }

    return indexes;
}

function collectionContainsSessionPrice(collection) {
    return findSessionPriceIndexes(collection).length > 0;
}

/**
 * PART 2 — stage snapshot before collection is returned/passed onward.
 */
function logPackageStage({
    stageName,
    collectionName,
    collection,
    method = 'n/a',
    caller = 'n/a'
}) {
    const items = Array.isArray(collection) ? collection : [];
    const indexes = findSessionPriceIndexes(items);
    const contains = indexes.length > 0;

    console.log('==========================================================');
    console.log('PACKAGE STAGE');
    console.log('==========================================================');
    console.log('Stage Name:');
    console.log(stageName);
    console.log('Collection Name:');
    console.log(collectionName);
    console.log('Metadata Count:');
    console.log(items.length);
    console.log('Contains Session__c.Price__c ?');
    console.log(contains ? 'YES' : 'NO');

    if (contains) {
        for (const index of indexes) {
            console.log('The COMPLETE metadata object');
            console.log(JSON.stringify(items[index], null, 2));
            console.log('The source collection name');
            console.log(collectionName);
            console.log('Current method');
            console.log(method);
            console.log('Caller (if available)');
            console.log(caller);
            console.log('Index:');
            console.log(index);
        }
    }

    console.log('==========================================================');
}

/**
 * PART 3 — fired when Session__c.Price__c is inserted into a collection.
 */
function logSessionPriceInserted({
    method,
    caller = 'n/a',
    collectionReceiving,
    collectionSource = 'n/a',
    metadataObject
}) {
    if (!isSessionPrice(metadataObject)) {
        return;
    }

    console.log('==========================================================');
    console.log('SESSION PRICE INSERTED');
    console.log('==========================================================');
    console.log('Method:');
    console.log(method);
    console.log('Caller:');
    console.log(caller);
    console.log('Collection receiving item:');
    console.log(collectionReceiving);
    console.log('Collection source:');
    console.log(collectionSource);
    console.log('Metadata object:');
    console.log(JSON.stringify(metadataObject, null, 2));
    console.log('Current stack (top few frames)');
    console.log(getTopStack());
    console.log('==========================================================');
}

/**
 * PART 5 — already present before package assembly.
 */
function logFoundBeforePackageBuild({
    collectionName,
    method,
    collection
}) {
    const items = Array.isArray(collection) ? collection : [];
    const indexes = findSessionPriceIndexes(items);

    if (!indexes.length) {
        return;
    }

    for (const index of indexes) {
        console.log('==========================================================');
        console.log('FOUND BEFORE PACKAGE BUILD');
        console.log('==========================================================');
        console.log('Collection:');
        console.log(collectionName);
        console.log('Method:');
        console.log(method);
        console.log('Index:');
        console.log(index);
        console.log('Metadata object');
        console.log(JSON.stringify(items[index], null, 2));
        console.log('==========================================================');
    }
}

/**
 * PART 4 — final package immediately before Workspace Builder.
 */
function logFinalPackageBeforeWorkspace(generatedDeploymentPackage) {
    const metadata = generatedDeploymentPackage?.metadata || [];
    const dependencies = generatedDeploymentPackage?.dependencies || [];
    const combined = [...metadata, ...dependencies];
    const indexes = findSessionPriceIndexes(combined);

    console.log('==========================================================');
    console.log('FINAL PACKAGE BEFORE WORKSPACE');
    console.log('==========================================================');
    console.log('Total metadata:');
    console.log(combined.length);
    console.log('Does package contain');
    console.log('Session__c.Price__c ?');
    console.log(indexes.length ? 'YES' : 'NO');

    if (indexes.length) {
        for (const index of indexes) {
            console.log('Index');
            console.log(index);
            console.log('Complete metadata object');
            console.log(JSON.stringify(combined[index], null, 2));
            console.log(
                index < metadata.length
                    ? '(from generatedDeploymentPackage.metadata)'
                    : '(from generatedDeploymentPackage.dependencies)'
            );
        }
    }

    console.log('==========================================================');
}

module.exports = {
    SESSION_PRICE_NAME,
    SESSION_PRICE_TYPE,
    isSessionPrice,
    findSessionPriceIndexes,
    collectionContainsSessionPrice,
    logPackageStage,
    logSessionPriceInserted,
    logFoundBeforePackageBuild,
    logFinalPackageBeforeWorkspace,
    getTopStack
};
