const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

exports.generateComparisonSummary = async (req, res) => {

    try {

        const {
            comparisonName,
            totalFiles,
            groupedResults
        } = req.body;

        const prompt = `
You are a Salesforce DevOps expert.

Generate a short business-friendly comparison summary.

Comparison:
${comparisonName}

Total Changed Files:
${totalFiles}

Metadata Breakdown:
${JSON.stringify(groupedResults, null, 2)}

Return:
1. Executive Summary
2. Major Impact Areas
3. Risk Level (Low/Medium/High)
4. Recommended Testing Areas

Keep response under 250 words.
`;

        const response =
            await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt
            });

        res.json({
            success: true,
            summary: response.text
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

};