'use strict';

const {
    SNAPSHOT_EXPORT_ERROR_CODE,
    SnapshotExportError
} = require('../services/deploymentSnapshot/snapshotExport.errors');
const {
    retrieveSnapshotArtifact
} = require('../services/deploymentSnapshot/snapshotExport.service');

function mapExportError(error) {
    if (!(error instanceof SnapshotExportError)) {
        return {
            httpStatus: 500,
            body: {
                success: false,
                code: 'SNAPSHOT_ARTIFACT_INTERNAL_ERROR',
                message: 'Unable to retrieve snapshot artifact.'
            }
        };
    }

    if (error.code === SNAPSHOT_EXPORT_ERROR_CODE.INVALID_REQUEST) {
        return {
            httpStatus: 400,
            body: {
                success: false,
                code: error.code,
                message: error.message
            }
        };
    }

    if (
        error.code === SNAPSHOT_EXPORT_ERROR_CODE.NOT_FOUND ||
        error.code === SNAPSHOT_EXPORT_ERROR_CODE.ARTIFACT_NOT_FOUND
    ) {
        return {
            httpStatus: 404,
            body: {
                success: false,
                code: error.code,
                message: error.message
            }
        };
    }

    return {
        httpStatus: 503,
        body: {
            success: false,
            code: error.code,
            message: error.message
        }
    };
}

exports.getSnapshotArtifact = async (req, res) => {
    try {
        const snapshotId = req.query.snapshotId;
        const artifactId = req.query.artifactId;
        const historyId = req.query.historyId;

        const bytes = await retrieveSnapshotArtifact({
            snapshotId,
            artifactId,
            historyId
        });

        res.set('Content-Type', 'application/octet-stream');
        res.set('Cache-Control', 'no-store');
        return res.status(200).send(bytes);
    } catch (error) {
        const mapped = mapExportError(error);

        return res.status(mapped.httpStatus).json(mapped.body);
    }
};
