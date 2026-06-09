const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");

// =====================================
// Gemini Retry Helper
// =====================================

async function generateWithRetry(
    ai,
    prompt
) {

    for (let i = 0; i < 3; i++) {

        try {

            const response =
                await ai.models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: prompt
                });

            return response.text;

        } catch (error) {

            console.error(
                `Attempt ${i + 1} failed`,
                error.message
            );

            if (
                error.message.includes('503')
                &&
                i < 2
            ) {

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            2000
                        )
                );

                continue;
            }

            throw error;
        }
    }
}

async function generateWithOpenAI(prompt) {

    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    const response =
        await openai.chat.completions.create({

            model: "gpt-4o-mini",

            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ]

        });

    return response
        .choices[0]
        .message
        .content;
}

// =====================================
// AI Comparison Summary
// =====================================

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
            groupedResults,
            model
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

        let summary;

if (model === 'openai') {

    summary =
        await generateWithOpenAI(
            prompt
        );

} else {

    summary =
        await generateWithRetry(
            ai,
            prompt
        );
}

        return res.json({
            success: true,
            summary
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            error:
                'AI service is currently busy. Please try again in a few moments.'

        });

    }

};

// =====================================
// AI Explain Git Diff
// =====================================

exports.explainDiff =
async (req, res) => {

    try {

        const ai = new GoogleGenAI({
            apiKey:
                process.env.GEMINI_API_KEY
        });

        const {
            fileName,
            metadataType,
            diff,
            model
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

Return plain text.
Do not use markdown.
Keep response under 250 words.
`;

        let explanation;

if (model === 'openai') {

    explanation =
        await generateWithOpenAI(
            prompt
        );

} else {

    explanation =
        await generateWithRetry(
            ai,
            prompt
        );
}

        return res.json({
            success: true,
            explanation
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            success: false,

            error:
                'AI service is currently busy. Please try again in a few moments.'

        });

    }

};