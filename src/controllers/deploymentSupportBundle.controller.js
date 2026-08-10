const supportBundleApi = require('../services/supportBundle/supportBundleApi.service');

/**
 * Phase 17.8 — On-demand Enterprise Support Bundle (download-only JSON).
 * Diagnostic only. Never deploys, validates Salesforce, auto-fixes, emails, or calls AI.
 */
exports.createSupportBundle = async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};

        console.log(
            '[Support Bundle] POST /api/deployment/support-bundle validationId=' +
                String(body.validationId || body.historyId || '')
        );

        const result = await supportBundleApi.createSupportBundleFromRequest(
            body
        );

        return res.status(200).json({
            success: true,
            supportBundle: result.supportBundle,
            delivery: result.delivery
        });
    } catch (error) {
        if (error instanceof supportBundleApi.SupportBundleRequestError) {
            return res.status(error.statusCode || 400).json({
                success: false,
                error: error.message
            });
        }

        console.error('SUPPORT BUNDLE ERROR');
        console.error(error?.message || error);

        return res.status(500).json({
            success: false,
            error: 'Unable to generate support bundle.'
        });
    }
};
