const { exec } = require('child_process');

exports.checkGit = async (req, res) => {

    exec(
        'git --version',
        (error, stdout, stderr) => {

            if (error) {

                return res.status(500).json({
                    success: false,
                    error: stderr || error.message
                });

            }

            return res.json({
                success: true,
                output: stdout
            });

        }
    );

};