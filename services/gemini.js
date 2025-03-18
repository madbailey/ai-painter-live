const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize conversation history
let conversationHistory = [];

// Add streaming mode controls
let streamingModeActive = false;
let lastCanvasAnalysis = null;
let streamingBatchSize = 3; // Number of commands to send in each batch
let lastStreamingUpdateTime = 0;
let minStreamingUpdateInterval = 1000; // Minimum milliseconds between streaming updates

const systemPrompt = `You are an AI artist assistant that controls a canvas drawing application. Your responses must be PURE JSON ARRAYS (no markdown formatting, no backticks) containing drawing commands.

First, describe what you see on the canvas (if anything). Then, create a plan for what to draw based on the user's prompt and the current canvas state. FOLLOW A STRUCTURED THREE-PHASE DRAWING PROCESS:

PHASE 1 - STRUCTURE & OUTLINE (0-30% completion)
- Use ONLY pencil, brush, rectangle, and circle tools
- Focus on creating the basic structure and outlines
- Use thin lines with small line widths (1-3)
- Sketch out the composition with basic shapes
- Keep colors simple, preferably black (#000000)

PHASE 2 - COLORING & FILLING (31-70% completion)
- Use ONLY the fill and rectangle tools to add color
- Fill in large areas defined in Phase 1
- Use a variety of colors appropriate to the subject
- Work from background to foreground
- Add base colors to all major elements

PHASE 3 - DETAILS & REFINEMENT (71-100% completion)
- Use ANY tool including spray for texturing and details
- Add highlights, shadows, and texture
- Refine edges and add final touches
- Use the pencil tool for fine details
- Complete any missing elements

Available commands:

1. Draw lines and shapes:
{ "endpoint": "/api/draw", "params": { "tool": "pencil|brush|rectangle|circle|fill|spray|eraser", "color": "#RRGGBB", "lineWidth": number, "startX": number, "startY": number, "x": number, "y": number }}

2. Change tools:
{ "endpoint": "/api/tool", "params": { "tool": "pencil|brush|rectangle|circle|fill|spray|eraser" }}

3. Change colors:
{ "endpoint": "/api/color", "params": { "color": "#RRGGBB" }}

4. Change line width:
{ "endpoint": "/api/linewidth", "params": { "width": number }}

5. Clear canvas:
{ "endpoint": "/api/clear" }

6. Pause to analyze the canvas (will trigger a new canvas state capture):
{ "endpoint": "/api/pause", "params": { "duration": 1000 }}

7. Continue drawing with more commands and update phase:
{ "endpoint": "/api/continue", "params": { "completionPercentage": number, "currentPhase": 1|2|3 }}

8. Request to advance to next phase (when current phase is complete):
{ "endpoint": "/api/next_phase", "params": { "completedPhase": 1|2, "completionPercentage": number }}

The canvas size is 800x600 pixels.

TOOL DESCRIPTIONS:
- pencil: Draws thin precise lines, good for details and outlines
- brush: Draws thicker, smoother lines, good for broader strokes
- rectangle: Creates rectangle outlines from startX,startY to x,y
- circle: Creates circle outlines with center at startX,startY and radius determined by distance to x,y
- fill: Fills an area with the selected color (like a paint bucket tool), use startX,startY as the starting point
- spray: Creates a spray paint effect around point x,y with density based on lineWidth
- eraser: Removes parts of the drawing, replacing them with white

IMPORTANT INSTRUCTIONS:
1. STRICTLY FOLLOW THE PHASE RESTRICTIONS for tools and approaches
2. Complete one phase fully before requesting to move to the next phase
3. Use the pause command frequently (every 5-10 drawing actions) to analyze progress
4. End each set of commands with a pause followed by a continue command with updated completionPercentage and currentPhase
5. When a phase is complete, use the next_phase command to explicitly request advancement
6. Use at least 10-15 drawing commands for each phase
7. For complex drawings, use MULTIPLE ITERATIONS of commands within each phase

Example - Drawing a landscape in three phases:

PHASE 1 - Structure & Outline (0-30%):
[
    {"endpoint": "/api/tool", "params": {"tool": "pencil"}},
    {"endpoint": "/api/color", "params": {"color": "#000000"}},
    {"endpoint": "/api/linewidth", "params": {"width": 2}},
    {"endpoint": "/api/draw", "params": {"tool": "pencil", "color": "#000000", "lineWidth": 2, "startX": 0, "startY": 300, "x": 800, "y": 300}},
    {"endpoint": "/api/draw", "params": {"tool": "pencil", "color": "#000000", "lineWidth": 2, "startX": 100, "startY": 300, "x": 200, "y": 200}},
    {"endpoint": "/api/pause", "params": {"duration": 1000}},
    {"endpoint": "/api/continue", "params": {"completionPercentage": 15, "currentPhase": 1}},
    
    {"endpoint": "/api/tool", "params": {"tool": "circle"}},
    {"endpoint": "/api/draw", "params": {"tool": "circle", "color": "#000000", "lineWidth": 2, "startX": 600, "startY": 100, "x": 650, "y": 100}},
    {"endpoint": "/api/pause", "params": {"duration": 1000}},
    {"endpoint": "/api/next_phase", "params": {"completedPhase": 1, "completionPercentage": 30}}
]

PHASE 2 - Coloring & Filling (31-70%):
[
    {"endpoint": "/api/tool", "params": {"tool": "fill"}},
    {"endpoint": "/api/color", "params": {"color": "#87CEEB"}},
    {"endpoint": "/api/draw", "params": {"tool": "fill", "color": "#87CEEB", "lineWidth": 1, "startX": 400, "startY": 150, "x": 400, "y": 150}},
    {"endpoint": "/api/pause", "params": {"duration": 1000}},
    {"endpoint": "/api/continue", "params": {"completionPercentage": 45, "currentPhase": 2}},
    
    {"endpoint": "/api/color", "params": {"color": "#7CFC00"}},
    {"endpoint": "/api/draw", "params": {"tool": "fill", "color": "#7CFC00", "lineWidth": 1, "startX": 400, "startY": 450, "x": 400, "y": 450}},
    {"endpoint": "/api/pause", "params": {"duration": 1000}},
    {"endpoint": "/api/next_phase", "params": {"completedPhase": 2, "completionPercentage": 70}}
]

PHASE 3 - Details & Refinement (71-100%):
[
    {"endpoint": "/api/tool", "params": {"tool": "spray"}},
    {"endpoint": "/api/color", "params": {"color": "#FFFFFF"}},
    {"endpoint": "/api/linewidth", "params": {"width": 10}},
    {"endpoint": "/api/draw", "params": {"tool": "spray", "color": "#FFFFFF", "lineWidth": 10, "startX": 600, "startY": 100, "x": 600, "y": 100}},
    {"endpoint": "/api/pause", "params": {"duration": 1000}},
    {"endpoint": "/api/continue", "params": {"completionPercentage": 85, "currentPhase": 3}},
    
    {"endpoint": "/api/tool", "params": {"tool": "pencil"}},
    {"endpoint": "/api/color", "params": {"color": "#8B4513"}},
    {"endpoint": "/api/linewidth", "params": {"width": 1}},
    {"endpoint": "/api/draw", "params": {"tool": "pencil", "color": "#8B4513", "lineWidth": 1, "startX": 250, "startY": 400, "x": 250, "y": 500}},
    {"endpoint": "/api/pause", "params": {"duration": 1000}},
    {"endpoint": "/api/continue", "params": {"completionPercentage": 100, "currentPhase": 3}}
]

IMPORTANT: Respond ONLY with a JSON array of commands. Do not include any explanation text, markdown formatting, or backticks.`;

// Modified system prompt with streaming mode instructions
const streamingSystemPrompt = `You are a digital artist that creates drawings based on user prompts. In streaming mode, you provide 2-3 drawing commands at a time as a JSON array.

IMPORTANT: Focus on creating a clear, recognizable drawing that matches the user's prompt. Each command should make meaningful progress toward the final image.

Always include ALL parameters in your drawing commands:
- tool: which tool to use (pencil, brush, rectangle, circle, fill, spray, eraser)
- color: hex color code (e.g., "#FF0000" for red)
- lineWidth: thickness of lines (usually 2-10 for good visibility)
- startX, startY: starting coordinates
- x, y: ending coordinates

Canvas is 800x600 pixels.

Available commands:
1. Draw: { "endpoint": "/api/draw", "params": { "tool": "pencil|brush|rectangle|circle|fill|spray|eraser", "color": "#RRGGBB", "lineWidth": number, "startX": number, "startY": number, "x": number, "y": number }}
2. Change tool: { "endpoint": "/api/tool", "params": { "tool": "pencil|brush|rectangle|circle|fill|spray|eraser" }}
3. Change color: { "endpoint": "/api/color", "params": { "color": "#RRGGBB" }}
4. Change line width: { "endpoint": "/api/linewidth", "params": { "width": number }}
5. Pause: { "endpoint": "/api/pause", "params": { "duration": 1000 }}

STREAMING GUIDELINES:
1. Provide ONLY 2-3 commands per response
2. Use shapes and lines that directly relate to the user's prompt
3. Build the drawing logically, step by step
4. Always end with a pause command
5. Maintain spatial relationships between elements
6. NEVER use random coordinates - always draw something relevant to the prompt
7. Make steady, visible progress toward the intended image

CONSTRAINTS:
1. All coordinates must be within 800x600 bounds
2. Follow a logical drawing sequence: structure → filling → details
3. Use colors appropriate to the subject
4. Maintain consistent proportions and perspective`;

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
            contents: [{ parts }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8192,
                topP: 0.9,
                topK: 40
            }
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

async function analyzeLiveCanvas(canvasState, previousAnalysis = null, originalPrompt = null) {
    console.log('\n=== Processing Live Canvas Analysis ===');
    
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        // Prepare the parts with canvas state and analysis prompt
        const parts = [];
        
        if (canvasState) {
            const base64Data = canvasState.replace(/^data:image\/\w+;base64,/, '');
            parts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: base64Data
                }
            });
        }
        
        // Special prompt for live analysis mode
        const liveAnalysisPrompt = `
            Analyze this canvas in relation to the prompt: "${originalPrompt || 'unknown subject'}"
            Provide a detailed assessment of what's currently drawn and what's still needed.
            Describe what you see and evaluate how complete the drawing is relative to the requested prompt.
            Identify what elements are missing or could be improved to better match the prompt.
            
            Format your response as JSON:
            {
                "analysis": "detailed description of what you see",
                "suggestions": ["specific drawing elements to add", "areas to improve", "details to enhance"],
                "completionPercentage": number from 0-100 (how complete the drawing is)
            }
        `;
        
        parts.push({ text: liveAnalysisPrompt });
        
        // If we have previous analysis, include it for context
        if (previousAnalysis) {
            parts.push({ text: `Previous analysis: ${JSON.stringify(previousAnalysis)}` });
        }
        
        // Generate analysis
        const result = await model.generateContent({
            contents: [{ parts }],
            generationConfig: {
                temperature: 0.2,  // Lower temp for more consistent analyses
                maxOutputTokens: 1024,
                topP: 0.8,
                topK: 40
            }
        });
        
        const response = await result.response;
        const text = response.text().trim();
        
        // Parse the analysis JSON
        try {
            const cleanJson = text.replace(/^```json\n|\n```$/g, '').trim();
            const analysis = JSON.parse(cleanJson);
            console.log('Canvas analysis results:', JSON.stringify(analysis, null, 2));
            return analysis;
        } catch (error) {
            console.error('Failed to parse analysis:', error);
            return null;
        }
    } catch (error) {
        console.error('Error analyzing canvas:', error);
        return null;
    } finally {
        console.log('=== Canvas Analysis Complete ===\n');
    }
}

async function continueDrawing(canvasState, originalPrompt, currentPhase = 1) {
    console.log('\n=== Continuing Drawing Process ===');
    console.log(`Current phase: ${currentPhase}`);
    
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        // First analyze the current canvas state
        const analysis = await analyzeLiveCanvas(canvasState);
        if (!analysis) {
            console.error('Failed to analyze canvas state');
            return [];
        }
        
        console.log('Canvas analysis:', JSON.stringify(analysis, null, 2));
        
        // If drawing is already complete, don't continue
        if (analysis.completionPercentage >= 95) {
            console.log('Drawing is already complete (≥95%)');
            return [];
        }
        
        // Get phase-specific instructions
        const phaseInstructions = getPhaseInstructions(currentPhase);
        
        // Prepare a special continuation prompt
        const continuePrompt = `
            Continue drawing the ${originalPrompt || 'current image'}.
            
            CURRENT PHASE: ${currentPhase} - ${phaseInstructions.name}
            
            Current canvas analysis:
            - Description: ${analysis.analysis}
            - Completion: ${analysis.completionPercentage}%
            
            PHASE RESTRICTIONS:
            ${phaseInstructions.restrictions}
            
            Please add more elements following the current phase guidelines.
            Focus on adding: ${analysis.suggestions?.join(', ') || 'more details'}
            
            Respond with additional drawing commands for phase ${currentPhase}.
            ${currentPhase < 3 && analysis.completionPercentage >= phaseInstructions.thresholdPercentage ? 
              "When you've completed this phase, use the next_phase command to advance." : ""}
        `;
        
        console.log('Continuation prompt:', continuePrompt);
        
        // Prepare the content parts for the continuation request
        const parts = [];
        
        // Add canvas state
        if (canvasState) {
            const base64Data = canvasState.replace(/^data:image\/\w+;base64,/, '');
            parts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: base64Data
                }
            });
        }
        
        // Add system prompt and continuation prompt
        parts.push({ text: systemPrompt });
        parts.push({ text: continuePrompt });
        
        // Generate new commands
        console.log('Requesting additional drawing commands for phase', currentPhase);
        const result = await model.generateContent({
            contents: [{ parts }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8192, 
                topP: 0.9,
                topK: 40
            }
        });
        
        const response = await result.response;
        const text = response.text().trim();
        
        // Parse the continuation commands
        try {
            const cleanJson = text.replace(/^```json\n|\n```$/g, '').trim();
            const commands = JSON.parse(cleanJson);
            
            if (!Array.isArray(commands)) {
                throw new Error('Response is not an array');
            }
            
            console.log('Successfully parsed continuation commands:', commands.length);
            return commands;
        } catch (error) {
            console.error('Failed to parse continuation commands:', error);
            return [];
        }
    } catch (error) {
        console.error('Error continuing drawing:', error);
        return [];
    } finally {
        console.log('=== Drawing Continuation Complete ===\n');
    }
}

// Helper function to get phase-specific instructions
function getPhaseInstructions(phase) {
    switch (phase) {
        case 1:
            return {
                name: "STRUCTURE & OUTLINE",
                restrictions: "Use ONLY pencil, brush, rectangle, and circle tools. Keep colors simple, preferably black.",
                thresholdPercentage: 25
            };
        case 2:
            return {
                name: "COLORING & FILLING",
                restrictions: "Use ONLY the fill and rectangle tools to add color. Focus on filling in large areas defined in Phase 1.",
                thresholdPercentage: 65
            };
        case 3:
            return {
                name: "DETAILS & REFINEMENT",
                restrictions: "Use ANY tool including spray for texturing and details. Add highlights, shadows, and texture.",
                thresholdPercentage: 95
            };
        default:
            return {
                name: "UNKNOWN PHASE",
                restrictions: "No specific restrictions.",
                thresholdPercentage: 95
            };
    }
}

// New function for streaming mode interactions
async function streamingModeUpdate(canvasState, originalPrompt, currentPhase = 1) {
    console.log('\n=== Streaming Mode Update ===');
    console.log('Original prompt:', originalPrompt);
    console.log('Current phase:', currentPhase);
    
    // Remove the throttling mechanism - we'd rather have slower commands than no commands
    // if (now - lastStreamingUpdateTime < minStreamingUpdateInterval) {
    //     console.log(`Throttling streaming update: ${now - lastStreamingUpdateTime}ms since last update`);
    //     return [{ "endpoint": "/api/pause", "params": { "duration": 1000 }}];
    // }
    
    lastStreamingUpdateTime = Date.now();
    
    if (!streamingModeActive) {
        console.log('Streaming mode not active, activating now');
        streamingModeActive = true;
    }
    
    try {
        // Log what we're doing
        console.log(`Processing streaming update at ${new Date().toISOString()}`);
        
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        
        // First analyze the current canvas state
        const analysis = await analyzeLiveCanvas(canvasState, lastCanvasAnalysis, originalPrompt);
        if (!analysis) {
            console.error('Failed to analyze canvas state');
            // Return simple drawing command instead of empty array
            return getEmergencyDrawCommand(currentPhase, originalPrompt);
        }
        
        // Save the current analysis regardless of changes
        lastCanvasAnalysis = analysis;
        console.log('Canvas analysis:', JSON.stringify(analysis, null, 2));
        
        // Remove the significant change check - we want drawing commands every time
        // if (!significantChange) {
        //     console.log('No significant changes detected - returning pause command only');
        //     return [{ "endpoint": "/api/pause", "params": { "duration": 1000 }}];
        // }
        
        // If drawing is already complete, stop streaming
        if (analysis.completionPercentage >= 95) {
            console.log('Drawing is complete (≥95%), stopping streaming mode');
            streamingModeActive = false;
            return [{ 
                "endpoint": "/api/continue", 
                "params": { "completionPercentage": 100, "currentPhase": 3 }
            }];
        }
        
        // Get phase-specific context
        const phaseInstructions = getPhaseInstructions(currentPhase);
        
        // Prepare a special streaming prompt that emphasizes action
        const streamingPrompt = `
            I need to draw: "${originalPrompt}" in streaming mode.
            
            Current canvas state (${analysis.completionPercentage}% complete):
            ${analysis.analysis}
            
            Current phase: Phase ${currentPhase} - ${phaseInstructions.name}
            
            YOU MUST provide EXACTLY 2-3 drawing commands that will make VISIBLE changes to the canvas.
            Focus on: ${analysis.suggestions?.slice(0, 2).join(', ') || 'creating recognizable elements that match the prompt'}
            
            IMPORTANT RULES:
            1. YOU MUST provide at least one /api/draw command in your response
            2. EVERY command MUST include ALL parameters
            3. Each command must create something directly related to the prompt
            4. YOUR RESPONSE WILL BE REJECTED if it does not include at least one drawing command
            
            DO NOT waste time with tool changes unless absolutely necessary.
            Remember to end with a pause command.
            
            The user prompt is: "${originalPrompt}"
        `;
        
        console.log('Streaming prompt prepared');
        
        // Prepare the content parts for the streaming request
        const parts = [];
        
        // Add canvas state first
        if (canvasState) {
            const base64Data = canvasState.replace(/^data:image\/\w+;base64,/, '');
            parts.push({
                inlineData: {
                    mimeType: 'image/png',
                    data: base64Data
                }
            });
        }
        
        // Add streaming system prompt and contextual prompt
        parts.push({ text: streamingSystemPrompt });
        parts.push({ text: streamingPrompt });
        
        // Add an example of a well-formed drawing command for the current phase
        const exampleCommands = getExampleCommandsForPhase(currentPhase, originalPrompt);
        parts.push({ text: `Example commands for this phase: ${JSON.stringify(exampleCommands)}` });
        
        // Generate streaming commands
        console.log('Requesting streaming drawing commands...');
        const result = await model.generateContent({
            contents: [{ parts }],
            generationConfig: {
                temperature: 0.7, // Higher temperature for more creativity
                maxOutputTokens: 1024,
                topP: 0.9,
                topK: 40
            }
        });
        
        const response = await result.response;
        const text = response.text().trim();
        
        // Parse the streaming commands
        try {
            const cleanJson = text.replace(/^```json\n|\n```$/g, '').trim();
            const commands = JSON.parse(cleanJson);
            
            if (!Array.isArray(commands)) {
                throw new Error('Response is not an array');
            }
            
            // Ensure we don't exceed batch size
            const batchedCommands = commands.slice(0, streamingBatchSize);
            
            // Validate that the commands include at least one draw command
            let hasDrawCommand = batchedCommands.some(cmd => cmd.endpoint === '/api/draw');
            
            // If no draw commands, return emergency draw commands
            if (!hasDrawCommand) {
                console.log('No draw commands received, using emergency commands');
                return getEmergencyDrawCommand(currentPhase, originalPrompt);
            }
            
            // Make sure we end with a pause to trigger the next update
            if (batchedCommands.length > 0 && 
                (batchedCommands[batchedCommands.length - 1].endpoint !== '/api/pause')) {
                batchedCommands.push({
                    "endpoint": "/api/pause", 
                    "params": {"duration": 1000}
                });
            }
            
            console.log('Streaming batch commands:', batchedCommands.length);
            return batchedCommands;
        } catch (error) {
            console.error('FAILURE: Failed to parse streaming commands:', error);
            return getEmergencyDrawCommand(currentPhase, originalPrompt);
        }
    } catch (error) {
        console.error('FAILURE: Error in streaming mode update:', error);
        return getEmergencyDrawCommand(currentPhase, originalPrompt);
    } finally {
        console.log('=== Streaming Update Complete ===\n');
    }
}

// New helper function that returns emergency drawing commands
function getEmergencyDrawCommand(phase, prompt) {
    // Always provide at least one drawing command based on the phase
    console.log('Generating emergency drawing command');
    
    const canvas_width = 800;
    const canvas_height = 600;
    const centerX = canvas_width / 2;
    const centerY = canvas_height / 2;
    
    // Generate a semi-random position that stays in center-ish region
    const randomX = Math.floor(Math.random() * (canvas_width * 0.6) + canvas_width * 0.2);
    const randomY = Math.floor(Math.random() * (canvas_height * 0.6) + canvas_height * 0.2);
    
    // Colors appropriate for beach scene
    const beachColors = ['#F4A460', '#87CEEB', '#008080', '#FFD700', '#CD853F', '#000000'];
    const randomColor = beachColors[Math.floor(Math.random() * beachColors.length)];
    
    switch(phase) {
        case 1: // Outline phase - draw a simple shape
            return [
                { "endpoint": "/api/tool", "params": { "tool": "pencil" }},
                { "endpoint": "/api/color", "params": { "color": "#000000" }},
                { "endpoint": "/api/linewidth", "params": { "width": 2 }},
                { "endpoint": "/api/draw", "params": { 
                    "tool": "pencil", 
                    "color": "#000000", 
                    "lineWidth": 2, 
                    "startX": randomX, 
                    "startY": randomY, 
                    "x": randomX + 50, 
                    "y": randomY + 50 
                }},
                { "endpoint": "/api/pause", "params": { "duration": 1000 }}
            ];
        case 2: // Coloring phase - add some color
            return [
                { "endpoint": "/api/tool", "params": { "tool": "fill" }},
                { "endpoint": "/api/color", "params": { "color": randomColor }},
                { "endpoint": "/api/draw", "params": { 
                    "tool": "fill", 
                    "color": randomColor, 
                    "lineWidth": 1, 
                    "startX": randomX, 
                    "startY": randomY, 
                    "x": randomX, 
                    "y": randomY 
                }},
                { "endpoint": "/api/pause", "params": { "duration": 1000 }}
            ];
        default: // Detail phase - add some details
            return [
                { "endpoint": "/api/tool", "params": { "tool": "pencil" }},
                { "endpoint": "/api/color", "params": { "color": randomColor }},
                { "endpoint": "/api/draw", "params": { 
                    "tool": "pencil", 
                    "color": randomColor, 
                    "lineWidth": 3, 
                    "startX": randomX, 
                    "startY": randomY, 
                    "x": randomX + 20, 
                    "y": randomY + 20 
                }},
                { "endpoint": "/api/pause", "params": { "duration": 1000 }}
            ];
    }
}

// Function to provide example commands for different phases
function getExampleCommandsForPhase(phase, prompt) {
    switch(phase) {
        case 1:
            return [
                { "endpoint": "/api/tool", "params": { "tool": "pencil" }},
                { "endpoint": "/api/color", "params": { "color": "#000000" }},
                { "endpoint": "/api/draw", "params": { 
                    "tool": "pencil", 
                    "color": "#000000", 
                    "lineWidth": 2, 
                    "startX": 300, 
                    "startY": 200, 
                    "x": 500, 
                    "y": 300 
                }},
                { "endpoint": "/api/pause", "params": { "duration": 1000 }}
            ];
        case 2:
            return [
                { "endpoint": "/api/tool", "params": { "tool": "fill" }},
                { "endpoint": "/api/color", "params": { "color": "#3366CC" }},
                { "endpoint": "/api/draw", "params": { 
                    "tool": "fill", 
                    "color": "#3366CC", 
                    "lineWidth": 1, 
                    "startX": 400, 
                    "startY": 300, 
                    "x": 400, 
                    "y": 300 
                }},
                { "endpoint": "/api/pause", "params": { "duration": 1000 }}
            ];
        case 3:
            return [
                { "endpoint": "/api/tool", "params": { "tool": "spray" }},
                { "endpoint": "/api/color", "params": { "color": "#FF9900" }},
                { "endpoint": "/api/draw", "params": { 
                    "tool": "spray", 
                    "color": "#FF9900", 
                    "lineWidth": 10, 
                    "startX": 350, 
                    "startY": 250, 
                    "x": 350, 
                    "y": 250 
                }},
                { "endpoint": "/api/pause", "params": { "duration": 1000 }}
            ];
        default:
            return [
                { "endpoint": "/api/tool", "params": { "tool": "pencil" }},
                { "endpoint": "/api/color", "params": { "color": "#000000" }},
                { "endpoint": "/api/draw", "params": { 
                    "tool": "pencil", 
                    "color": "#000000", 
                    "lineWidth": 2, 
                    "startX": 300, 
                    "startY": 200, 
                    "x": 500, 
                    "y": 300 
                }},
                { "endpoint": "/api/pause", "params": { "duration": 1000 }}
            ];
    }
}

// Function to toggle streaming mode
function toggleStreamingMode(isActive) {
    streamingModeActive = isActive;
    if (!isActive) {
        lastCanvasAnalysis = null;
    }
    console.log(`Streaming mode ${isActive ? 'activated' : 'deactivated'}`);
    return streamingModeActive;
}

// Function to adjust streaming batch size
function setStreamingBatchSize(size) {
    streamingBatchSize = Math.max(1, Math.min(5, size)); // Limit between 1-5
    console.log(`Streaming batch size set to ${streamingBatchSize}`);
    return streamingBatchSize;
}

module.exports = {
    processUserPrompt,
    clearConversation,
    analyzeLiveCanvas,
    continueDrawing,
    streamingModeUpdate,
    toggleStreamingMode,
    setStreamingBatchSize
}; 