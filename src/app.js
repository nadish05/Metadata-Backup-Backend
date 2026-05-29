require('dotenv').config();

const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health.routes');

const oauthRoutes =
require('./routes/oauth.routes');

app.use('/api/oauth', oauthRoutes);

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', healthRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(`Server running on port ${PORT}`);

});