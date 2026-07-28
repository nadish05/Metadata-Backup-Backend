/**
 * Deployment Package Provenance — read-only response projection.
 *
 * Explains WHY metadata exists in the final deployment package.
 * Does not participate in package creation, validation, planner, or deploy.
 * Consumes only in-memory artifacts from the current validation run.
 */

const SCHEMA_VERSION = '1.0';

const PACKAGE_ROLES = Object.freeze({
    PRIMARY: 'PRIMARY',
    AUTO_INCLUDED: 'AUTO_INCLUDED'
});

const ORIGIN_TYPES = Object.freeze({
    USER_SELECTED: 'USER_SELECTED',
    REVIEW_DEPENDENCY: 'REVIEW_DEPENDENCY',
    RELATIONSHIP_DEPENDENCY: 'RELATIONSHIP_DEPENDENCY',
    METADATA_REFERENCE: 'METADATA_REFERENCE',
    RESOLUTION_REQUIREMENT: 'RESOLUTION_REQUIREMENT',
    GRAPH_EXPANSION: 'GRAPH_EXPANSION',
    PLANNER_OVERRIDE: 'PLANNER_OVERRIDE',
    AI_OPTIMIZATION: 'AI_OPTIMIZATION',
    MANUAL_OVERRIDE: 'MANUAL_OVERRIDE',
    SYSTEM: 'SYSTEM',
    UNKNOWN: 'UNKNOWN'
});

const ORIGIN_TYPE_ORDER = [
    ORIGIN_TYPES.USER_SELECTED,
    ORIGIN_TYPES.REVIEW_DEPENDENCY,
    ORIGIN_TYPES.RELATIONSHIP_DEPENDENCY,
    ORIGIN_TYPES.METADATA_REFERENCE,
    ORIGIN_TYPES.GRAPH_EXPANSION,
    ORIGIN_TYPES.RESOLUTION_REQUIREMENT,
    ORIGIN_TYPES.PLANNER_OVERRIDE,
    ORIGIN_TYPES.AI_OPTIMIZATION,
    ORIGIN_TYPES.MANUAL_OVERRIDE,
    ORIGIN_TYPES.SYSTEM,
    ORIGIN_TYPES.UNKNOWN
];

function buildMemberKey(metadataType, metadataName) {
    if (!metadataType || !metadataName) {
        return null;
    }

    return `${metadataType}:${metadataName}`;
}

function resolveItemType(item) {
    return item?.metadataType || item?.type || null;
}

function resolveItemName(item) {
    return item?.metadataName || item?.name || null;
}

function buildSelectedMetadataKeys(selectedMetadata) {
    const keys = new Set();

    for (const item of selectedMetadata || []) {
        const key = buildMemberKey(
            resolveItemType(item),
            resolveItemName(item)
        );

        if (key) {
            keys.add(key);
        }
    }

    return keys;
}

function createOrigin({
    originType,
    contributor = null,
    relatedMetadataType = null,
    relatedMetadataName = null,
    relationKind = null,
    explanation = null
}) {
    return {
        originType,
        contributor,
        relatedMetadataType,
        relatedMetadataName,
        relationKind,
        explanation
    };
}

function originDedupKey(origin) {
    return [
        origin.originType,
        origin.contributor || '',
        origin.relatedMetadataType || '',
        origin.relatedMetadataName || '',
        origin.relationKind || '',
        origin.explanation || ''
    ].join('|');
}

function addOrigin(originsByKey, origin) {
    if (!origin?.originType) {
        return;
    }

    const key = originDedupKey(origin);

    if (originsByKey.has(key)) {
        return;
    }

    originsByKey.set(key, origin);
}

function mapDiscovererToOriginType(discoveredBy, relationship, referenceType) {
    const contributor = discoveredBy ? String(discoveredBy) : null;
    const relation = relationship || referenceType || null;

    if (!contributor && !relation) {
        return null;
    }

    if (
        contributor === 'DeploymentReview' ||
        relation === 'DeploymentReview'
    ) {
        return ORIGIN_TYPES.REVIEW_DEPENDENCY;
    }

    if (contributor === 'UserSelection') {
        return ORIGIN_TYPES.USER_SELECTED;
    }

    if (
        contributor === 'FlexiPageReferenceDiscoverer' ||
        contributor === 'REFERENCE_DISCOVERY' ||
        referenceType
    ) {
        return ORIGIN_TYPES.METADATA_REFERENCE;
    }

    if (
        contributor === 'GraphExpansion' ||
        (contributor && /GraphDiscoverer$/i.test(contributor))
    ) {
        return ORIGIN_TYPES.GRAPH_EXPANSION;
    }

    if (
        contributor === 'CustomObjectRelationshipDiscoverer' ||
        contributor === 'CustomObjectActionOverrideDiscoverer' ||
        relation === 'Lookup' ||
        relation === 'MasterDetail' ||
        relation === 'RelatedObject'
    ) {
        return ORIGIN_TYPES.RELATIONSHIP_DEPENDENCY;
    }

    if (contributor === 'RESOLVER') {
        return ORIGIN_TYPES.RESOLUTION_REQUIREMENT;
    }

    if (contributor) {
        return ORIGIN_TYPES.SYSTEM;
    }

    return null;
}

function inferRelatedMetadataType(item, fallbackType) {
    if (item?.sourceMetadataType) {
        return item.sourceMetadataType;
    }

    if (fallbackType) {
        return fallbackType;
    }

    return null;
}

function collectOriginsFromRelationships(memberKey, discoveredRelationships) {
    const origins = [];

    for (const relationship of discoveredRelationships || []) {
        const key = buildMemberKey(
            resolveItemType(relationship),
            resolveItemName(relationship)
        );

        if (key !== memberKey) {
            continue;
        }

        const relationKind =
            relationship.relationship || relationship.relationKind || null;
        const originType = mapDiscovererToOriginType(
            relationship.discoveredBy,
            relationKind,
            null
        );

        if (!originType) {
            continue;
        }

        origins.push(
            createOrigin({
                originType,
                contributor: relationship.discoveredBy || null,
                relatedMetadataType: inferRelatedMetadataType(
                    relationship,
                    relationship.sourceMetadata ? 'CustomObject' : null
                ),
                relatedMetadataName: relationship.sourceMetadata || null,
                relationKind,
                explanation: relationship.reason || null
            })
        );
    }

    return origins;
}

function collectOriginsFromReferences(memberKey, discoveredReferences) {
    const origins = [];

    for (const reference of discoveredReferences || []) {
        const key = buildMemberKey(
            resolveItemType(reference),
            resolveItemName(reference)
        );

        if (key !== memberKey) {
            continue;
        }

        const relationKind =
            reference.referenceType || reference.relationship || null;
        const originType =
            mapDiscovererToOriginType(
                reference.discoveredBy,
                null,
                relationKind
            ) || ORIGIN_TYPES.METADATA_REFERENCE;

        origins.push(
            createOrigin({
                originType,
                contributor: reference.discoveredBy || null,
                relatedMetadataType: inferRelatedMetadataType(
                    reference,
                    reference.sourceMetadata ? 'FlexiPage' : null
                ),
                relatedMetadataName: reference.sourceMetadata || null,
                relationKind,
                explanation: reference.reason || null
            })
        );
    }

    return origins;
}

/**
 * Use only clear categorical signals from resolved/package dependency rows.
 * Never invent origin from DEFAULT alone.
 */
function collectOriginsFromDependencyDecision(memberKey, dependencyRows) {
    const origins = [];

    for (const dependency of dependencyRows || []) {
        const key = buildMemberKey(
            resolveItemType(dependency),
            resolveItemName(dependency)
        );

        if (key !== memberKey) {
            continue;
        }

        const relationKind = dependency.relationship || null;
        const decisionSource = dependency.source || null;

        if (decisionSource === 'RESOLVER') {
            origins.push(
                createOrigin({
                    originType: ORIGIN_TYPES.RESOLUTION_REQUIREMENT,
                    contributor: 'RESOLVER',
                    relatedMetadataType: null,
                    relatedMetadataName: null,
                    relationKind,
                    explanation: dependency.reason || null
                })
            );
        }

        if (
            relationKind === 'DeploymentReview' ||
            dependency.discoveredBy === 'DeploymentReview' ||
            dependency.discoveryMethod === 'deploymentReview'
        ) {
            origins.push(
                createOrigin({
                    originType: ORIGIN_TYPES.REVIEW_DEPENDENCY,
                    contributor:
                        dependency.discoveredBy || 'DeploymentReview',
                    relatedMetadataType: inferRelatedMetadataType(
                        dependency,
                        dependency.sourceMetadata ? 'CustomObject' : null
                    ),
                    relatedMetadataName: dependency.sourceMetadata || null,
                    relationKind: relationKind || 'DeploymentReview',
                    explanation: dependency.reason || null
                })
            );
        } else if (
            relationKind === 'Lookup' ||
            relationKind === 'MasterDetail' ||
            relationKind === 'RelatedObject'
        ) {
            const mapped = mapDiscovererToOriginType(
                dependency.discoveredBy,
                relationKind,
                null
            );

            if (mapped) {
                origins.push(
                    createOrigin({
                        originType: mapped,
                        contributor: dependency.discoveredBy || null,
                        relatedMetadataType: inferRelatedMetadataType(
                            dependency,
                            dependency.sourceMetadata
                                ? 'CustomObject'
                                : null
                        ),
                        relatedMetadataName:
                            dependency.sourceMetadata || null,
                        relationKind,
                        explanation: dependency.reason || null
                    })
                );
            }
        }
    }

    return origins;
}

function sortOrigins(origins) {
    return [...origins].sort((a, b) => {
        const orderA = ORIGIN_TYPE_ORDER.indexOf(a.originType);
        const orderB = ORIGIN_TYPE_ORDER.indexOf(b.originType);
        const safeA = orderA === -1 ? ORIGIN_TYPE_ORDER.length : orderA;
        const safeB = orderB === -1 ? ORIGIN_TYPE_ORDER.length : orderB;

        if (safeA !== safeB) {
            return safeA - safeB;
        }

        return String(a.contributor || '').localeCompare(
            String(b.contributor || '')
        );
    });
}

function buildPackageMembers(generatedDeploymentPackage) {
    const members = [];
    const seen = new Set();

    for (const item of generatedDeploymentPackage?.metadata || []) {
        const metadataType = resolveItemType(item);
        const metadataName = resolveItemName(item);
        const key = buildMemberKey(metadataType, metadataName);

        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        members.push({ metadataType, metadataName, key });
    }

    return members.sort((a, b) => {
        const typeCompare = a.metadataType.localeCompare(b.metadataType);

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return a.metadataName.localeCompare(b.metadataName);
    });
}

function buildSummary(members) {
    let primaryCount = 0;
    let autoIncludedCount = 0;
    let multiOriginCount = 0;

    for (const member of members) {
        if (member.packageRole === PACKAGE_ROLES.PRIMARY) {
            primaryCount += 1;
        } else {
            autoIncludedCount += 1;
        }

        if ((member.origins || []).length > 1) {
            multiOriginCount += 1;
        }
    }

    return {
        memberCount: members.length,
        primaryCount,
        autoIncludedCount,
        multiOriginCount
    };
}

function emptyProvenance(generatedAt) {
    return {
        schemaVersion: SCHEMA_VERSION,
        generatedAt,
        summary: {
            memberCount: 0,
            primaryCount: 0,
            autoIncludedCount: 0,
            multiOriginCount: 0
        },
        members: []
    };
}

/**
 * Build deploymentPackageProvenance from already-computed validation artifacts.
 * Report-only. Never mutates inputs. Never performs I/O.
 *
 * @param {{
 *   generatedDeploymentPackage?: object,
 *   selectedMetadata?: Array,
 *   discoveredRelationships?: Array,
 *   discoveredReferences?: Array,
 *   resolvedDependencies?: Array
 * }} params
 */
function buildDeploymentPackageProvenance({
    generatedDeploymentPackage,
    selectedMetadata,
    discoveredRelationships,
    discoveredReferences,
    resolvedDependencies
} = {}) {
    const generatedAt = new Date().toISOString();

    try {
        const packageMembers = buildPackageMembers(generatedDeploymentPackage);

        if (!packageMembers.length) {
            return emptyProvenance(generatedAt);
        }

        const selectedKeys = buildSelectedMetadataKeys(selectedMetadata);
        const dependencyRows = [
            ...(resolvedDependencies || []),
            ...(generatedDeploymentPackage?.dependencies || [])
        ];

        const members = packageMembers.map((packageMember) => {
            const originsByKey = new Map();

            if (selectedKeys.has(packageMember.key)) {
                addOrigin(
                    originsByKey,
                    createOrigin({
                        originType: ORIGIN_TYPES.USER_SELECTED,
                        contributor: 'UserSelection',
                        relatedMetadataType: null,
                        relatedMetadataName: null,
                        relationKind: 'Selected',
                        explanation: 'Explicitly selected for deployment.'
                    })
                );
            }

            for (const origin of collectOriginsFromRelationships(
                packageMember.key,
                discoveredRelationships
            )) {
                addOrigin(originsByKey, origin);
            }

            for (const origin of collectOriginsFromReferences(
                packageMember.key,
                discoveredReferences
            )) {
                addOrigin(originsByKey, origin);
            }

            for (const origin of collectOriginsFromDependencyDecision(
                packageMember.key,
                dependencyRows
            )) {
                addOrigin(originsByKey, origin);
            }

            let origins = sortOrigins([...originsByKey.values()]);

            if (!origins.length) {
                origins = [
                    createOrigin({
                        originType: ORIGIN_TYPES.UNKNOWN,
                        contributor: null,
                        relatedMetadataType: null,
                        relatedMetadataName: null,
                        relationKind: null,
                        explanation:
                            'Provenance could not be determined from available validation data.'
                    })
                ];
            }

            return {
                metadataType: packageMember.metadataType,
                metadataName: packageMember.metadataName,
                packageRole: selectedKeys.has(packageMember.key)
                    ? PACKAGE_ROLES.PRIMARY
                    : PACKAGE_ROLES.AUTO_INCLUDED,
                origins
            };
        });

        return {
            schemaVersion: SCHEMA_VERSION,
            generatedAt,
            summary: buildSummary(members),
            members
        };
    } catch (error) {
        console.error('DEPLOYMENT PACKAGE PROVENANCE ERROR');
        console.error(error);
        return emptyProvenance(generatedAt);
    }
}

module.exports = {
    buildDeploymentPackageProvenance,
    PACKAGE_ROLES,
    ORIGIN_TYPES,
    SCHEMA_VERSION
};
