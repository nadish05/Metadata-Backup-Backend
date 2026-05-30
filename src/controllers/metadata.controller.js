const { exec } = require('child_process');

exports.checkSfCli = async (req, res) => {

    exec('sf --version', (error, stdout, stderr) => {

        if (error) {
            return res.status(500).json({
                success: false,
                error: stderr || error.message
            });
        }

        res.json({
            success: true,
            version: stdout
        });

    });

};