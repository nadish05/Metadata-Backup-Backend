/**
 * Parse Salesforce Metadata API Layout member names.
 *
 * Format: {ObjectApiName}-{Layout Label}
 * Split on the FIRST hyphen only — layout labels may contain hyphens.
 */

function parseLayoutMemberName(memberName) {
    const normalized = String(memberName || '').trim();

    if (!normalized) {
        return null;
    }

    const separatorIndex = normalized.indexOf('-');

    if (separatorIndex <= 0 || separatorIndex >= normalized.length - 1) {
        return null;
    }

    const objectApiName = normalized.slice(0, separatorIndex).trim();
    const layoutName = normalized.slice(separatorIndex + 1).trim();

    if (!objectApiName || !layoutName) {
        return null;
    }

    return {
        objectApiName,
        layoutName
    };
}

module.exports = {
    parseLayoutMemberName
};
