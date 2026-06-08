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
You are a Salesforce DevOps Architect.

Analyze the metadata comparison and generate a concise executive summary.

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

Instructions:

- Maximum 200 words
- Use simple business-friendly language
- Use bullet points
- Do not explain every metadata type
- Keep the output concise

Return exactly:

Executive Summary:
(2-3 sentences)

Major Impact Areas:
• Area 1
• Area 2
• Area 3

Risk Level:
Low / Medium / High

Recommended Testing:
• Test Area 1
• Test Area 2
• Test Area 3
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


exports.explainDiff = async (req, res) => {

    try {

        const ai = new GoogleGenAI({
            apiKey:
                process.env.GEMINI_API_KEY
        });

        const {
            fileName,
            metadataType,
            diff
        } = req.body;

        const prompt = `
You are a Salesforce Technical Architect.

Analyze this Git diff.

File Name:
${fileName}

Metadata Type:
${metadataType}

Git Diff:
${diff}

Provide:

Purpose:
(What this file does)

Changes Detected:
(What changed)

Business Impact:
(Impact in simple language)

Risk Level:
(Low, Medium, High)

Recommended Testing:
(Testing recommendations)

Keep response under 250 words.
`;

        const response =
            await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt
            });

        return res.json({
            success: true,
            explanation:
                response.text
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            error:
                error.message
        });

    }

};