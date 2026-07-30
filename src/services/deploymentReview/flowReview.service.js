/**
 * Flow Review — Phase 1 + Phase 2.
 *
 * Supports Flow as a reviewable metadata type.
 * Reads embedded <apiVersion> from .flow-meta.xml for display only.
 * Discovers Flow metadata dependencies from XML (Phase 2).
 */

const {
    analyzeFlowDependencies
} = require('./flowDependencyAnalyzer.service');

const FLOW_META_SUFFIX = '.flow-meta.xml';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

/**
 * Resolve Flow API name from a DX file path.
 * Uses the full .flow-meta.xml suffix (not path.extname, which is only .xml).
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function getFlowApiName(filePath) {
    if (!filePath) {
        return null;
    }

    const baseName = normalizePath(filePath).split('/').pop() || '';

    if (baseName.endsWith(FLOW_META_SUFFIX)) {
        return baseName.slice(0, -FLOW_META_SUFFIX.length) || null;
    }

    return null;
}

/**
 * Extract Salesforce API version embedded in Flow metadata XML.
 *
 * @param {string} content
 * @returns {string|null}
 */
function extractFlowApiVersion(content) {
    if (!content) {
        return null;
    }

    const match = String(content).match(
        /<apiVersion>\s*([\d.]+)\s*<\/apiVersion>/i
    );

    return match ? match[1] : null;
}

/**
 * Build a Deployment Review result for a Flow file.
 *
 * @param {{ content: string, filePath: string }} params
 * @returns {object}
 */
function analyzeFlowReview({ content, filePath }) {
    const metadataName = getFlowApiName(filePath);
    const apiVersion = extractFlowApiVersion(content);
    const dependencyAnalysis = analyzeFlowDependencies(content);

    return {
        metadataType: 'Flow',
        metadataName,
        filePath,
        status: 'SUCCESS',
        apiValidation: {
            supported: Boolean(apiVersion),
            apiVersion
        },
        dependencyAnalysis
    };
}

module.exports = {
    getFlowApiName,
    extractFlowApiVersion,
    analyzeFlowReview,
    FLOW_META_SUFFIX
};
