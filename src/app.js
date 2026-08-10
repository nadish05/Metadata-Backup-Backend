require('dotenv').config();

const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health.routes');

const oauthRoutes =
require('./routes/oauth.routes');

const tokenRoutes =
    require('./routes/token.routes');

const metadataRoutes =
    require('./routes/metadata.routes');

const githubRoutes =
    require('./routes/github.routes');

const compareRoutes =
    require('./routes/compare.routes');

const aiRoutes =
    require('./routes/ai.routes');

const aiAdvisorRoutes =
    require('./routes/aiAdvisor.routes');

const deploymentRoutes =
    require(
        './routes/deployment.routes'
    );

const deploymentReviewRoutes =
    require(
        './routes/deploymentReview.routes'
    );

const sourceValidateRoutes =
    require(
        './routes/sourceValidate.routes'
    );

const sourceValidationRoutes =
    require(
        './routes/sourceValidation.routes'
    );

const deploymentHistoryRoutes =
    require(
        './routes/deploymentHistory.routes'
    );

const {
    applyJsonBodyParsing,
    applySupportBundlePayloadTooLargeHandler
} = require('./middleware/supportBundleBodyLimit');





const app = express();

app.use(cors());

// Phase 18.3.3: Support Bundle gets a route-scoped 1 MB JSON limit BEFORE
// the global ~100 KB parser. Do not raise the global limit.
applyJsonBodyParsing(app);

app.use('/api', healthRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api/token', tokenRoutes);
app.use('/api/metadata', metadataRoutes);
app.use('/api/github',githubRoutes);
app.use('/api/compare',compareRoutes);
app.use('/api/ai',aiRoutes);
app.use('/api/ai', aiAdvisorRoutes);
app.use('/api/deployment',deploymentRoutes);
app.use('/api/deployment', deploymentReviewRoutes);
app.use('/api/deployment', sourceValidateRoutes);
app.use('/api/deployment', sourceValidationRoutes);
app.use('/api/deployments', deploymentHistoryRoutes);

applySupportBundlePayloadTooLargeHandler(app);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(`Server running on port ${PORT}`);

});
