/**
 * TEMPORARY DEBUG ONLY — Phase 15.3.2 query trace verification harness.
 *
 * Verifies the request / response / error logging offline using the real SOQL
 * from the shared destination query catalog and the Salesforce payload shapes
 * a rejected query produces. No org is contacted, nothing is deployed, and the
 * SOQL is not modified.
 *
 * Run:  node src/services/personAccountQueryTrace.temp.harness.js
 */

const personAccountQueryTrace = require('./personAccountQueryTrace.temp');
const {
    buildExistenceQuery
} = require('./destinationInventory/destinationExistenceQueries');

const TRACED_CONTEXT = {
    metadataType: 'RecordType',
    metadataName: 'PersonAccount.PersonAccount'
};

const INSTANCE_URL = 'https://stub.my.salesforce.com';
const API_VERSION = '65.0';

/** Salesforce's actual payload shape for a rejected query (HTTP 400). */
function buildInvalidFieldError(soql) {
    const error = new Error('Request failed with status code 400');

    error.response = {
        status: 400,
        data: [
            {
                message:
                    `\n${soql}\n` +
                    '                                       ^\n' +
                    'ERROR at Row:1:Column:40\n' +
                    "No such column 'IsPersonType' on entity 'RecordType'. If you are " +
                    "attempting to use a custom field, be sure to append the '__c' after " +
                    'the custom field name. Please reference your WSDL or the describe ' +
                    'call for the appropriate names.',
                errorCode: 'INVALID_FIELD'
            }
        ]
    };

    return error;
}

function buildEndpoint(soql) {
    return `${INSTANCE_URL}/services/data/v${API_VERSION}/query/?q=${encodeURIComponent(
        soql
    )}`;
}

function runScenario(scenario) {
    const soql = buildExistenceQuery(
        TRACED_CONTEXT.metadataType,
        TRACED_CONTEXT.metadataName
    );

    console.log('');
    console.log('####################################################');
    console.log(`PERSON ACCOUNT QUERY TRACE SCENARIO — ${scenario}`);
    console.log('####################################################');
    console.log('');

    personAccountQueryTrace.beginQueryTrace();
    personAccountQueryTrace.logQueryRequest({
        ...TRACED_CONTEXT,
        endpoint: buildEndpoint(soql),
        soql,
        apiVersion: API_VERSION,
        api: 'REST'
    });

    if (scenario === 'INVALID_FIELD') {
        personAccountQueryTrace.logQueryError({
            ...TRACED_CONTEXT,
            error: buildInvalidFieldError(soql)
        });
    } else {
        personAccountQueryTrace.logQueryResponse({
            ...TRACED_CONTEXT,
            status: 200,
            data: {
                totalSize: 1,
                done: true,
                records: [
                    {
                        Id: '0125j000000ABCDAA2',
                        DeveloperName: 'PersonAccount',
                        SobjectType: 'Account',
                        IsPersonType: true
                    }
                ]
            }
        });
    }

    const traceState = personAccountQueryTrace.getQueryTraceState();

    console.log('HTTP status:', traceState.httpStatus);
    console.log('Accepted:', traceState.accepted);
    console.log('Failure type:', traceState.failureType || '(none)');
}

function main() {
    runScenario('INVALID_FIELD');
    runScenario('SUCCESS');
    console.log('');
}

main();
