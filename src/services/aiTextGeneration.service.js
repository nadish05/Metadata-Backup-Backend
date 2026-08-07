/**
 * Shared GPT / Gemini text generation used by Comparison AI Summary,
 * Metadata Difference Explanation, and the Deployment AI Resolution Layer.
 *
 * Single client entry point — do not instantiate parallel AI clients elsewhere.
 */

const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');

async function generateWithGeminiRetry(prompt, options = {}) {
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    const model = options.model || 'gemini-2.5-flash';
    const ai = options.client || new GoogleGenAI({ apiKey });

    for (let i = 0; i < 3; i++) {
        try {
            const response = await ai.models.generateContent({
                model,
                contents: prompt
            });

            return typeof response?.text === 'string'
                ? response.text
                : typeof response?.text === 'function'
                  ? response.text()
                  : String(response?.text || '');
        } catch (error) {
            console.error(`Attempt ${i + 1} failed`, error.message);

            if (error.message?.includes('503') && i < 2) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }

            throw error;
        }
    }

    return '';
}

async function generateWithOpenAI(prompt, options = {}) {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    const model = options.model || 'gpt-4o-mini';
    const openai = options.client || new OpenAI({ apiKey });

    const response = await openai.chat.completions.create({
        model,
        messages: [
            {
                role: 'user',
                content: prompt
            }
        ]
    });

    return response?.choices?.[0]?.message?.content || '';
}

/**
 * Generate plain text from the shared OpenAI / Gemini clients.
 *
 * @param {string} prompt
 * @param {{ provider?: string, model?: string, apiKey?: string, client?: object }} [options]
 * @returns {Promise<{ text: string, provider: string }>}
 */
async function generateAiText(prompt, options = {}) {
    const provider = String(options.provider || options.model || 'gemini')
        .trim()
        .toLowerCase();

    if (provider === 'openai' || provider === 'gpt' || provider === 'gpt-4o-mini') {
        const text = await generateWithOpenAI(prompt, options);
        return { text, provider: 'openai' };
    }

    const text = await generateWithGeminiRetry(prompt, options);
    return { text, provider: 'gemini' };
}

module.exports = {
    generateAiText,
    generateWithOpenAI,
    generateWithGeminiRetry
};
