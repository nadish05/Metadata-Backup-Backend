/**
 * TEMPORARY DEBUG ONLY — Phase 15.3.2 Person Account destination query trace.
 *
 * Captures the exact REST request, response, and Salesforce error payload for
 * the single traced destination existence query:
 *   RecordType : PersonAccount.PersonAccount
 *
 * Logging only. Never changes the SOQL, the destination decision, the resolver,
 * package generation, workspace, or deployment gating.
 * Remove once the PersonAccount query investigation is complete.
 */

const TRACED_TYPE = 'RecordType';
const TRACED_NAME = 'PersonAccount.PersonAccount';

const FAILURE_TYPES = Object.freeze({
    INVALID_FIELD: 'INVALID_FIELD',
    INVALID_TYPE: 'INVALID_TYPE',
    MALFORMED_QUERY: 'MALFORMED_QUERY',
    INSUFFICIENT_ACCESS: 'INSUFFICIENT_ACCESS',
    OTHER: 'OTHER'
});

const state = createEmptyState();

function createEmptyState() {
    return {
        executed: false,
        endpoint: null,
        soql: null,
        apiVersion: null,
        api: null,
        httpStatus: null,
        accepted: null,
        totalSize: null,
        done: null,
        records: [],
        errorBody: null,
        errors: [],
        failureType: null,
        reason: null
    };
}

function banner(title) {
    console.log('====================================================');
    console.log(title);
    console.log('====================================================');
}

function value(input) {
    return input === null || input === undefined || input === ''
        ? '(unknown)'
        : String(input);
}

function isTracedQuery(context) {
    const metadataType = context?.metadataType || context?.type || null;
    const metadataName = context?.metadataName || context?.name || null;

    return metadataType === TRACED_TYPE && metadataName === TRACED_NAME;
}

/**
 * Normalize the Salesforce error body into a flat list of { errorCode, message }.
 * Salesforce returns an array for query errors, but single objects and plain
 * strings are handled so nothing in the payload is lost.
 */
function extractSalesforceErrors(body) {
    if (Array.isArray(body)) {
        return body.map((entry) => ({
            errorCode: entry?.errorCode || null,
            message: entry?.message || null,
            fields: entry?.fields || null
        }));
    }

    if (body && typeof body === 'object') {
        return [
            {
                errorCode: body.errorCode || body.error || null,
                message:
                    body.message || body.error_description || null,
                fields: body.fields || null
            }
        ];
    }

    if (typeof body === 'string' && body.trim()) {
        return [{ errorCode: null, message: body.trim(), fields: null }];
    }

    return [];
}

function classifyFailure(errors) {
    for (const entry of errors) {
        const code = String(entry?.errorCode || '').toUpperCase();

        if (code === 'INVALID_FIELD') {
            return FAILURE_TYPES.INVALID_FIELD;
        }

        if (code === 'INVALID_TYPE') {
            return FAILURE_TYPES.INVALID_TYPE;
        }

        if (code === 'MALFORMED_QUERY') {
            return FAILURE_TYPES.MALFORMED_QUERY;
        }

        if (code.startsWith('INSUFFICIENT_ACCESS')) {
            return FAILURE_TYPES.INSUFFICIENT_ACCESS;
        }
    }

    return FAILURE_TYPES.OTHER;
}

function beginQueryTrace() {
    Object.assign(state, createEmptyState());
}

/** Full outbound request, logged immediately before the HTTP call. */
function logQueryRequest(context = {}) {
    if (!isTracedQuery(context)) {
        return;
    }

    state.executed = true;
    state.endpoint = context.endpoint || null;
    state.soql = context.soql || null;
    state.apiVersion = context.apiVersion || null;
    state.api = context.api || null;

    banner('PERSON ACCOUNT QUERY REQUEST');
    console.log('');
    console.log('Endpoint:');
    console.log('');
    console.log(value(context.endpoint));
    console.log('');
    console.log('SOQL:');
    console.log('');
    console.log(value(context.soql));
    console.log('');
    console.log('API Version:');
    console.log('');
    console.log(value(context.apiVersion));
    console.log('');
    console.log('API:');
    console.log('');
    console.log(value(context.api));
    console.log('');
    console.log('====================================================');
}

/** Successful HTTP response, including a dump of every returned record. */
function logQueryResponse(context = {}) {
    if (!isTracedQuery(context)) {
        return;
    }

    const data = context.data || {};
    const records = Array.isArray(data.records) ? data.records : [];

    state.httpStatus = context.status ?? null;
    state.accepted = true;
    state.totalSize = data.totalSize ?? records.length;
    state.done = data.done ?? null;
    state.records = records;
    state.failureType = null;
    state.reason = null;

    banner('PERSON ACCOUNT QUERY RESPONSE');
    console.log('');
    console.log('HTTP Status:');
    console.log('');
    console.log(value(context.status));
    console.log('');
    console.log('Total Size:');
    console.log('');
    console.log(value(state.totalSize));
    console.log('');
    console.log('Done:');
    console.log('');
    console.log(value(state.done));
    console.log('');
    console.log('Records Returned:');
    console.log('');
    console.log(records.length);
    console.log('');

    for (const record of records) {
        console.log('Id:', value(record?.Id));
        console.log('DeveloperName:', value(record?.DeveloperName));
        console.log('SobjectType:', value(record?.SobjectType));
        console.log('IsPersonType:', value(record?.IsPersonType));
        console.log('----------------------------------------------------');
    }

    console.log('====================================================');

    logQueryAnalysis();
}

/** Failed HTTP response — every Salesforce error entry is printed. */
function logQueryError(context = {}) {
    if (!isTracedQuery(context)) {
        return;
    }

    const error = context.error || {};
    const body = error.response?.data ?? null;
    const errors = extractSalesforceErrors(body);

    state.httpStatus = error.response?.status ?? null;
    state.accepted = false;
    state.errorBody = body;
    state.errors = errors;
    state.failureType = classifyFailure(errors);
    state.reason =
        errors.find((entry) => entry.message)?.message ||
        error.message ||
        'Salesforce returned no error message.';

    banner('PERSON ACCOUNT QUERY ERROR');
    console.log('');
    console.log('HTTP Status:');
    console.log('');
    console.log(value(state.httpStatus));
    console.log('');
    console.log('Salesforce Error Body:');
    console.log('');
    console.log(
        body === null || body === undefined
            ? '(no response body)'
            : JSON.stringify(body, null, 2)
    );
    console.log('');

    if (!errors.length) {
        console.log('Error Code:');
        console.log('');
        console.log('(none)');
        console.log('');
        console.log('Message:');
        console.log('');
        console.log(value(error.message));
        console.log('');
    }

    for (const entry of errors) {
        console.log('Error Code:');
        console.log('');
        console.log(value(entry.errorCode));
        console.log('');
        console.log('Message:');
        console.log('');
        console.log(value(entry.message));
        console.log('');

        if (entry.fields && entry.fields.length) {
            console.log('Fields:');
            console.log('');
            console.log(entry.fields.join(', '));
            console.log('');
        }

        console.log('---------------------');
    }

    console.log('====================================================');

    logQueryAnalysis();
}

function logQueryAnalysis() {
    banner('PERSON ACCOUNT QUERY ANALYSIS');
    console.log('');
    console.log('Query Executed:');
    console.log('');
    console.log(state.executed ? 'YES' : 'NO');
    console.log('');
    console.log('HTTP Status:');
    console.log('');
    console.log(value(state.httpStatus));
    console.log('');
    console.log('Salesforce Accepted Query:');
    console.log('');
    console.log(state.accepted === true ? 'YES' : 'NO');
    console.log('');
    console.log('Returned Records:');
    console.log('');
    console.log(state.accepted === true ? value(state.totalSize) : '0');
    console.log('');
    console.log('Failure Type:');
    console.log('');
    console.log(state.accepted === true ? '(none)' : value(state.failureType));
    console.log('');
    console.log('Reason:');
    console.log('');
    console.log(
        state.accepted === true
            ? 'Query accepted by Salesforce.'
            : value(state.reason)
    );
    console.log('');
    console.log('====================================================');
}

function getQueryTraceState() {
    return JSON.parse(JSON.stringify(state));
}

module.exports = {
    TRACED_TYPE,
    TRACED_NAME,
    FAILURE_TYPES,
    isTracedQuery,
    extractSalesforceErrors,
    classifyFailure,
    beginQueryTrace,
    logQueryRequest,
    logQueryResponse,
    logQueryError,
    logQueryAnalysis,
    getQueryTraceState
};
