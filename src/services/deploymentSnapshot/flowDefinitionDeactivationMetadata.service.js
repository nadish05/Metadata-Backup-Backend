'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const { DEFAULT_API_VERSION } = require('../../config/salesforce');
const {
    generatePackageXml,
    generateManifest
} = require('../packageXml.service');
const { ROLLBACK_CODE, RollbackBlockedError } = require('./snapshotRestore.errors');

const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const rm = util.promisify(fs.rm);

const FLOW_DEFINITION_METADATA_TYPE = 'FlowDefinition';
const FLOW_DEFINITION_RELATIVE_DIR = 'force-app/main/default/flowDefinitions';

/**
 * Metadata API: activeVersionNumber 0 deactivates the flow definition (no active version).
 * Validated against Salesforce FlowDefinition metadata shape before deploy.
 */
const FLOW_DEFINITION_DEACTIVATED_ACTIVE_VERSION_NUMBER = 0;

function buildFlowDefinitionDeactivationMetadataXml({
    activeVersionNumber = FLOW_DEFINITION_DEACTIVATED_ACTIVE_VERSION_NUMBER
} = {}) {
    const version = Number(activeVersionNumber);

    if (!Number.isFinite(version) || version < 0) {
        throw new Error('FlowDefinition deactivation requires a non-negative version number.');
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<FlowDefinition xmlns="http://soap.sforce.com/2006/04/metadata">
    <activeVersionNumber>${version}</activeVersionNumber>
</FlowDefinition>
`;
}

function validateFlowDefinitionDeactivationMetadataXml(xmlText) {
    if (typeof xmlText !== 'string' || !xmlText.trim()) {
        return { ok: false, reason: 'EMPTY_METADATA' };
    }

    if (!xmlText.includes('<FlowDefinition')) {
        return { ok: false, reason: 'MISSING_FLOW_DEFINITION_ROOT' };
    }

    const match = xmlText.match(
        /<activeVersionNumber>\s*(\d+)\s*<\/activeVersionNumber>/
    );

    if (!match) {
        return { ok: false, reason: 'MISSING_ACTIVE_VERSION_NUMBER' };
    }

    const parsed = Number(match[1]);

    if (parsed !== FLOW_DEFINITION_DEACTIVATED_ACTIVE_VERSION_NUMBER) {
        return {
            ok: false,
            reason: 'UNSUPPORTED_ACTIVE_VERSION_NUMBER',
            activeVersionNumber: parsed
        };
    }

    return {
        ok: true,
        activeVersionNumber: parsed
    };
}

async function buildFlowDefinitionDeactivationWorkspace({
    flowDefinitionDeveloperName,
    apiVersion = null,
    tmpdir = os.tmpdir,
    rmFn = rm
} = {}) {
    if (
        typeof flowDefinitionDeveloperName !== 'string' ||
        !flowDefinitionDeveloperName.trim()
    ) {
        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            'FlowDefinition deactivation workspace requires a definition developer name.'
        );
    }

    const definitionName = flowDefinitionDeveloperName.trim();
    const workspacePath = path.join(
        tmpdir(),
        `rollback-flow-deactivate-${crypto.randomUUID()}`
    );
    let workspaceCreated = false;

    try {
        const metadataXml = buildFlowDefinitionDeactivationMetadataXml();
        const validation = validateFlowDefinitionDeactivationMetadataXml(metadataXml);

        if (!validation.ok) {
            throw new RollbackBlockedError(
                ROLLBACK_CODE.WORKSPACE_FAILED,
                `FlowDefinition deactivation metadata validation failed (${validation.reason}).`
            );
        }

        const relativePath = `${FLOW_DEFINITION_RELATIVE_DIR}/${definitionName}.flowDefinition-meta.xml`;
        const absolutePath = path.join(workspacePath, relativePath);

        await mkdir(workspacePath, { recursive: true });
        workspaceCreated = true;
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, metadataXml, 'utf8');

        const generatedDeploymentPackage = {
            metadata: [
                {
                    metadataType: FLOW_DEFINITION_METADATA_TYPE,
                    metadataName: definitionName,
                    filePath: relativePath
                }
            ],
            dependencies: []
        };

        const generatedManifest = generateManifest(
            generatedDeploymentPackage,
            apiVersion ? { deploymentApiVersion: apiVersion } : {}
        );
        const resolvedApiVersion =
            generatedManifest.summary?.apiVersion || apiVersion || DEFAULT_API_VERSION;
        const packageXml =
            generatedManifest.packageXml ||
            generatePackageXml(generatedDeploymentPackage, resolvedApiVersion);

        await writeFile(path.join(workspacePath, 'package.xml'), packageXml, 'utf8');

        return {
            workspacePath,
            workspaceCreated: true,
            packageXmlWritten: true,
            packageXmlPath: path.join(workspacePath, 'package.xml'),
            preDestructiveChangesPath: null,
            generatedDeploymentPackage,
            generatedManifest,
            flowDefinitionDeveloperName: definitionName,
            flowDefinitionDeactivationActiveVersionNumber:
                FLOW_DEFINITION_DEACTIVATED_ACTIVE_VERSION_NUMBER,
            metadataCopied: 1,
            dependenciesCopied: 0,
            copiedFiles: 2,
            missingFiles: [],
            status: 'READY',
            cleanup: async () => {
                if (!workspaceCreated) {
                    return;
                }

                try {
                    await rmFn(workspacePath, { recursive: true, force: true });
                } catch (error) {
                    console.error('FLOW_DEFINITION_DEACTIVATION_WORKSPACE_CLEANUP_FAILED');
                    console.error(error?.message || error);
                }
            }
        };
    } catch (error) {
        if (workspaceCreated) {
            try {
                await rmFn(workspacePath, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('FLOW_DEFINITION_DEACTIVATION_WORKSPACE_CLEANUP_FAILED');
                console.error(cleanupError?.message || cleanupError);
            }
        }

        if (error instanceof RollbackBlockedError) {
            throw error;
        }

        throw new RollbackBlockedError(
            ROLLBACK_CODE.WORKSPACE_FAILED,
            error.message || 'FlowDefinition deactivation workspace failed.'
        );
    }
}

module.exports = {
    FLOW_DEFINITION_METADATA_TYPE,
    FLOW_DEFINITION_DEACTIVATED_ACTIVE_VERSION_NUMBER,
    buildFlowDefinitionDeactivationMetadataXml,
    validateFlowDefinitionDeactivationMetadataXml,
    buildFlowDefinitionDeactivationWorkspace
};
