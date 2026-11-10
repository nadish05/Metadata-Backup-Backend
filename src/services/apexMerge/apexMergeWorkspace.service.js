'use strict';

/**
 * Phase 2 — apply sealed manifest bytes to deployment workspace.
 * Stub exports preserve module boundary for deploymentValidation integration.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    assertManifestCorrelation,
    verifyManifestUnitHashes,
    verifyManifestAgainstRepoPins,
    buildArtifactDescriptor,
    sha256Utf8
} = require('./apexMergeManifest.service');
const {
    withFetchedRepository,
    collectBranchHeads
} = require('./apexMergeGit.service');
const { mergeApexClassFull } = require('./apexMergeFullClass.service');
const { hasConflictMarkers } = require('./apexMergeFullClass.service');
const { companionMetaPath } = require('./apexMergePaths.util');

async function ensureParentDir(filePath) {
    await mkdir(path.dirname(filePath), { recursive: true });
}

async function writeVerifiedArtifact(absolutePath, content) {
    if (hasConflictMarkers(content)) {
        throw new ApexMergeError(
            MERGE_ERROR.CONFLICT_MARKERS,
            `Conflict markers present in ${absolutePath}.`
        );
    }

    await ensureParentDir(absolutePath);
    await writeFile(absolutePath, content, 'utf8');
    return buildArtifactDescriptor(content);
}

/**
 * Apply manifest to workspace — Phase 2 integration entry point.
 */
async function applyApexMergeFromManifest({
    workspacePath,
    apexMergeManifest,
    deploymentPackage,
    skippedClassNames = new Set()
} = {}) {
    if (!apexMergeManifest || !workspacePath) {
        return { applied: false, classes: [] };
    }

    assertManifestCorrelation(apexMergeManifest, {
        comparisonId: deploymentPackage?.comparisonId,
        deploymentPlanId: deploymentPackage?.deploymentPlanId
    });

    const repoUrl = apexMergeManifest.repoUrl || deploymentPackage?.repoUrl;
    const sourceBranch =
        apexMergeManifest.sourceBranch ||
        deploymentPackage?.sourceBranch ||
        deploymentPackage?.branch;
    const destinationBranch =
        apexMergeManifest.destinationBranch ||
        deploymentPackage?.destinationBranch;

    if (!repoUrl || !sourceBranch || !destinationBranch) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_MANIFEST,
            'Manifest is missing repository branch context.'
        );
    }

    const applied = [];

    await withFetchedRepository(repoUrl, async ({ repoPath }) => {
        const currentPins = await collectBranchHeads(
            repoPath,
            sourceBranch,
            destinationBranch
        );
        verifyManifestAgainstRepoPins(apexMergeManifest, currentPins);

        for (const unit of apexMergeManifest.units || []) {
            if (skippedClassNames.has(unit.metadataName)) {
                continue;
            }

            const mergeResult = await mergeApexClassFull({
                repoPath,
                sourceBranch,
                destinationBranch,
                metadataName: unit.metadataName,
                filePath: unit.filePath
            });

            const clsContent = mergeResult.artifacts.cls.content;
            const metaContent = mergeResult.artifacts.metaXml.content;

            verifyManifestUnitHashes(unit, {
                clsContent,
                metaContent
            });

            const clsRelative = unit.filePath.replace(/\\/g, '/');
            const metaRelative = unit.metaXmlPath || companionMetaPath(clsRelative);
            const clsAbsolute = path.join(workspacePath, ...clsRelative.split('/'));
            const metaAbsolute = path.join(workspacePath, ...metaRelative.split('/'));

            const writtenCls = await writeVerifiedArtifact(clsAbsolute, clsContent);
            const writtenMeta = await writeVerifiedArtifact(metaAbsolute, metaContent);

            if (
                writtenCls.sha256 !== unit.artifacts.cls.sha256 ||
                writtenMeta.sha256 !== unit.artifacts.metaXml.sha256
            ) {
                throw new ApexMergeError(
                    MERGE_ERROR.HASH_MISMATCH,
                    `Written artifact hash mismatch for ${unit.metadataName}.`
                );
            }

            applied.push({
                metadataName: unit.metadataName,
                filePath: clsRelative,
                metaXmlPath: metaRelative,
                sha256: {
                    cls: writtenCls.sha256,
                    metaXml: writtenMeta.sha256
                }
            });
        }
    });

    return { applied: true, classes: applied };
}

module.exports = {
    applyApexMergeFromManifest,
    sha256Utf8
};
