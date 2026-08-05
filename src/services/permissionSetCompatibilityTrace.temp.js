/**
 * TEMPORARY DEBUG ONLY — Phase 13.1 Permission Set Compatibility Trace.
 * Remove after the PermissionSet compatibility investigation is complete.
 * Logging only; never changes metadata or deployment behavior.
 */

function listOrNone(values) {
    return Array.isArray(values) && values.length ? values : ['(none)'];
}

function logPermissionSetCompatibilityTrace({
    permissionSet,
    detectedApiVersion,
    filePath,
    topLevelXmlNodes = [],
    unknownNodes = [],
    unsupportedProperties = [],
    compatibilityFindings = [],
    xml = null
} = {}) {
    console.log('=====================================');
    console.log('PERMISSION SET COMPATIBILITY TRACE');
    console.log('=====================================');
    console.log('Permission Set Name:', permissionSet || '(unknown)');
    console.log('API Version:', detectedApiVersion || '(unknown)');
    console.log('Detected API Version:', detectedApiVersion || '(unknown)');
    console.log('Complete XML file path:', filePath || '(unknown)');
    console.log('All top-level XML nodes:');
    console.log(listOrNone(topLevelXmlNodes));
    console.log('Unknown nodes:');
    console.log(listOrNone(unknownNodes));
    console.log('Unsupported nodes:');
    console.log(listOrNone(unsupportedProperties));
    console.log('Detected compatibility issues:');
    console.log(
        compatibilityFindings.length
            ? compatibilityFindings.map((finding) => ({
                  property: finding.property || null,
                  category: finding.category,
                  reason: finding.reason,
                  recommendedAction: finding.recommendedAction,
                  safeToRemove: finding.safeToRemove === true
              }))
            : ['(none)']
    );
    console.log('=====================================');
    console.log('PERMISSION SET XML AS DEPLOYED');
    console.log('=====================================');
    console.log(xml || '(PermissionSet XML unavailable)');
    console.log('=====================================');
}

module.exports = {
    logPermissionSetCompatibilityTrace
};
