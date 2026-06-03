const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

exports.getDifferentFiles = async (req, res) => {

    try {

        const {
            repoUrl,
            sourceBranch,
            destinationBranch
        } = req.body;

        return res.json({
            success: true,
            message: 'Compare endpoint working',
            repoUrl,
            sourceBranch,
            destinationBranch
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            error: error.message
        });

    }

};