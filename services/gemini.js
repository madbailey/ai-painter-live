const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize conversation history
let conversationHistory = [];

const systemPrompt = `You are an AI artist assistant that controls a canvas drawing application. Your responses must be PURE JSON ARRAYS (no markdown formatting, no backticks) containing drawing commands.

First, describe what you see on the canvas (if anything). Then, create a plan for what to draw based on the user's prompt and the current canvas state. Finally, execute your drawing plan with multiple iterations of commands.

Available commands:

1. Draw lines and shapes:
{ "endpoint": "/api/draw", "params": { "tool": "pencil|brush|rectangle|circle|eraser", "color": "#RRGGBB", "lineWidth": number, "startX": number, "startY": number, "x": number, "y": number }}

2. Change tools:
{ "endpoint": "/api/tool", "params": { "tool": "pencil|brush|rectangle|circle|eraser" }}

3. Change colors:
{ "endpoint": "/api/color", "params": { "color": "#RRGGBB" }}

4. Change line width:
{ "endpoint": "/api/linewidth", "params": { "width": number }}

5. Clear canvas:
{ "endpoint": "/api/clear" }

6. Pause to analyze the canvas (will trigger a new canvas state capture):
{ "endpoint": "/api/pause", "params": { "duration": 1000 }}

The canvas size is 800x600 pixels.

IMPORTANT INSTRUCTIONS:
1. Break your drawing down into logical steps
2. Use the pause command periodically to analyze the canvas
3. When drawing complex images, build them up layer by layer
4. Adapt your drawing based on what's already on the canvas
5. Use at least 10-20 drawing commands for detailed drawings
6. Vary your colors and line widths for more visual interest

Example - Drawing a sunset landscape iteratively:
[
    {"endpoint": "/api/color", "params": {"color": "#87CEEB"}},
    {"endpoint": "/api/tool", "params": {"tool": "rectangle"}},
    {"endpoint": "/api/linewidth", "params": {"width": 2}},
    {"endpoint": "/api/draw", "params": {"tool": "rectangle", "color": "#87CEEB", "lineWidth": 2, "startX": 0, "startY": 0, "x": 800, "y": 400}},
    {"endpoint": "/api/pause", "params": {"duration": 1000}},
    {"endpoint": "/api/color", "params": {"color": "#FFA500"}},
    {"endpoint": "/api/tool", "params": {"tool": "circle"}},
    {"endpoint": "/api/draw", "params": {"tool": "circle", "color": "#FFA500", "lineWidth": 2, "startX": 400, "startY": 150, "x": 450, "y": 200}},
    {"endpoint": "/api/pause", "params": {"duration": 1000}},
    {"endpoint": "/api/color", "params": {"color": "#008000"}},
    {"endpoint": "/api/tool", "params": {"tool": "rectangle"}},
    {"endpoint": "/api/draw", "params": {"tool": "rectangle", "color": "#008000", "lineWidth": 2, "startX": 0, "startY": 400, "x": 800, "y": 600}}
]

IMPORTANT: Respond ONLY with a JSON array of commands. Do not include any explanation text, markdown formatting, or backticks.`;

async function processUserPrompt(prompt, canvasState) {
    console.log('\n=== Processing New AI Request ===');
    console.log('User Prompt:', prompt);
    console.log('Canvas State Present:', !!canvasState);
    
    try {
        console.log('Initializing Gemini model...');
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        // Prepare the content parts
        const parts = [];
        console.log('Building content parts...');
        
        // If we have a canvas state, add it first (better for vision tasks)
        if (canvasState) {
            console.log('Processing canvas state...');
            // Remove the data:image/png;base64, prefix if it exists
            const base64Data = canvasState.replace(/^data:image\/\w+;base64,/, '');
            parts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: base64Data
                }
            });
            console.log('Added canvas state to parts');
        }
        
        // Add system prompt
        parts.push({ text: systemPrompt });
        console.log('Added system prompt to parts');
        
        // Add conversation history
        if (conversationHistory.length > 0) {
            console.log('Adding conversation history, entries:', conversationHistory.length);
            conversationHistory.forEach(msg => {
                parts.push({ text: msg });
            });
        }
        
        // Add current prompt
        parts.push({ text: prompt });
        console.log('Added user prompt to parts');

        // Generate content
        console.log('Sending request to Gemini API...');
        const result = await model.generateContent({
            contents: [{ parts }]
        });
        console.log('Received response from Gemini API');
        
        const response = await result.response;
        const text = response.text().trim();
        console.log('\nRaw AI Response:', text);

        // Try to parse the response as JSON
        try {
            console.log('\nAttempting to parse response as JSON...');
            // Remove any potential markdown formatting
            const cleanJson = text.replace(/^```json\n|\n```$/g, '').trim();
            console.log('Cleaned JSON:', cleanJson);
            
            const commands = JSON.parse(cleanJson);
            
            if (!Array.isArray(commands)) {
                throw new Error('Response is not an array');
            }
            
            console.log('\nSuccessfully parsed commands:', JSON.stringify(commands, null, 2));
            
            // Add the response to conversation history
            conversationHistory.push(prompt);
            conversationHistory.push(text);
            
            // Keep history limited to last 10 messages
            if (conversationHistory.length > 10) {
                conversationHistory = conversationHistory.slice(-10);
            }
            console.log('Updated conversation history, current length:', conversationHistory.length);
            
            return commands;
        } catch (error) {
            console.error('\n❌ Failed to parse AI response:', error.message);
            console.error('Raw response that failed parsing:', text);
            return [];
        }
    } catch (error) {
        console.error('\n❌ Error processing prompt:', error.message);
        console.error('Full error:', error);
        return [];
    } finally {
        console.log('=== Request Processing Complete ===\n');
    }
}

function clearConversation() {
    console.log('Clearing conversation history');
    conversationHistory = [];
}

module.exports = {
    processUserPrompt,
    clearConversation
}; 