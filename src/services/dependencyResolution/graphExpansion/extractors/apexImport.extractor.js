/**
 * Apex import extractor for LWC (and future JS) source files.
 * Extracts deployable ApexClass names from @salesforce/apex imports.
 */

const EXTRACTOR_ID = 'ApexImportExtractor';

const APEX_IMPORT_PATTERN =
    /@salesforce\/apex\/(?:[A-Za-z][\w]*\.)?([A-Za-z][\w]*)\.[A-Za-z][\w]*/g;

function stripComments(source) {
    return String(source || '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*$/gm, ' ');
}

/**
 * @param {string} sourceText
 * @returns {{ metadataType: string, name: string, extractorId: string, rawMatch: string }[]}
 */
function extract(sourceText) {
    const results = [];
    const seen = new Set();
    const text = stripComments(sourceText);
    let match;

    APEX_IMPORT_PATTERN.lastIndex = 0;

    while ((match = APEX_IMPORT_PATTERN.exec(text)) !== null) {
        const className = match[1];

        if (!className || seen.has(className)) {
            continue;
        }

        seen.add(className);
        results.push({
            metadataType: 'ApexClass',
            name: className,
            extractorId: EXTRACTOR_ID,
            rawMatch: match[0]
        });
    }

    return results;
}

module.exports = {
    id: EXTRACTOR_ID,
    metadataTypes: ['LightningComponentBundle'],
    extract
};
