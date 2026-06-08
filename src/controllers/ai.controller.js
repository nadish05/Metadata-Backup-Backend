const { GoogleGenAI } = require("@google/genai");

exports.generateComparisonSummary =
async (req, res) => {

    try {

        const ai = new GoogleGenAI({
            apiKey:
                process.env.GEMINI_API_KEY
        });

        const {
            comparisonName,
            totalFiles,
            groupedResults
        } = req.body;

        const prompt = `
Generate a professional Salesforce
metadata comparison summary.

Comparison:
${comparisonName}

Total Files Changed:
${totalFiles}

Metadata Breakdown:
${JSON.stringify(
    groupedResults,
    null,
    2
)}

Provide:

1. Executive Summary
2. Major Impact Areas
3. Risk Level
4. Recommended Testing
`;

        const response =
            await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt
            });

        return res.json({
            success: true,
            summary:
                response.text
        });

    } catch(error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error:
                error.message
        });

    }

};