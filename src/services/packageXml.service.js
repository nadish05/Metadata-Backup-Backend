const { DEFAULT_API_VERSION } = require('../config/salesforce');

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function groupMetadataByType(metadata) {
    const typeMap = new Map();

    if (!Array.isArray(metadata)) {
        return typeMap;
    }

    for (const item of metadata) {
        if (!item?.metadataType || !item?.metadataName) {
            continue;
        }

        const { metadataType, metadataName } = item;

        if (!typeMap.has(metadataType)) {
            typeMap.set(metadataType, new Set());
        }

        typeMap.get(metadataType).add(metadataName);
    }

    return typeMap;
}

function buildTypesXml(typeMap) {
    const sortedTypes = [...typeMap.keys()].sort((a, b) =>
        a.localeCompare(b)
    );

    return sortedTypes
        .map((metadataType) => {
            const members = [...typeMap.get(metadataType)].sort((a, b) =>
                a.localeCompare(b)
            );

            const membersXml = members
                .map(
                    (member) =>
                        `        <members>${escapeXml(member)}</members>`
                )
                .join('\n');

            return `    <types>
${membersXml}
        <name>${escapeXml(metadataType)}</name>
    </types>`;
        })
        .join('\n\n');
}

function generatePackageXml(
    generatedDeploymentPackage,
    apiVersion = DEFAULT_API_VERSION
) {
    const metadata = generatedDeploymentPackage?.metadata || [];
    const typeMap = groupMetadataByType(metadata);
    const typesXml = buildTypesXml(typeMap);

    if (typesXml) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">

${typesXml}

    <version>${escapeXml(apiVersion)}</version>

</Package>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">

    <version>${escapeXml(apiVersion)}</version>

</Package>`;
}

function generateManifest(generatedDeploymentPackage) {
    return {
        packageXml: generatePackageXml(generatedDeploymentPackage)
    };
}

module.exports = {
    generatePackageXml,
    generateManifest
};
