const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { processUserPrompt, clearConversation, continueDrawing, streamingModeUpdate, toggleStreamingMode, setStreamingBatchSize } = require('./services/gemini');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '.')));

// Store canvas state
let canvasState = null;
let connectedClients = new Set();

// Add a queue for pending canvas updates
let canvasUpdateQueue = new Map(); // client -> latest canvas data
let isProcessingAI = false;

//track consecutive errors 
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

//set a hearbeat system for connection stabiltiy 
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

const clientTimingMetrics = new Map();

// Add a tracker for the current drawing phase
let currentDrawingPhase = 1;

// Add streaming mode state tracking
let streamingModeEnabled = false;
const DEFAULT_STREAMING_INTERVAL = 500; // Increased to 500ms for smoother updates
const MIN_STREAMING_INTERVAL = 200; // Minimum allowed interval
const MAX_STREAMING_INTERVAL = 2000; // Maximum allowed interval

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('\n🔌 New client connected');
    console.log('Total connected clients:', connectedClients.size + 1);
    connectedClients.add(ws);
    
    // Initialize client state
    ws.originalPrompt = null;
    ws.currentPhase = 1;
    ws.streamingMode = false;
    ws.lastCanvasUpdate = Date.now();
    ws.streamingInterval = DEFAULT_STREAMING_INTERVAL;
    ws.isProcessingCommand = false;
    ws.lastCommandTime = 0;
    
    // Setup heartbeat for connection stability (do this only once per connection)
    if (!ws.heartbeatSetup) {
        ws.isAlive = true;
        
        // Remove any existing pong listeners if they exist
        ws.removeAllListeners('pong');
        
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        ws.heartbeatSetup = true;
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('\n📩 Received WebSocket message:', data.type);

            // Reset error count on successful message
            consecutiveErrors = 0;

            // Process the message based on its type
            switch (data.type) {
                case 'CANVAS_UPDATE':
                    console.log('Processing canvas update...');
                    const now = Date.now();
                    
                    // Store current canvas state
                    canvasState = data.canvasData;
                    
                    // Store canvas timestamp for timing diagnostics
                    const canvasStateTimestamp = now;
                    
                    // Add to queue instead of skipping - always store the latest update
                    if (ws.streamingMode && ws.originalPrompt) {
                        canvasUpdateQueue.set(ws, {
                            canvasData: canvasState,
                            timestamp: now
                        });
                        
                        // If we're not already processing, start processing the queue
                        if (!ws.isProcessingCommand) {
                            processNextCanvasUpdate();
                        } else {
                            console.log('AI is busy, update queued for later processing');
                        }
                    }
                    
                    // Always broadcast to other clients, even if we queue processing
                    broadcastToOthers(ws, {
                        type: 'CANVAS_UPDATE',
                        canvasData: canvasState,
                        timestamp: now
                    });
                    
                    console.log('Canvas state updated and broadcasted');
                    break;

                case 'DRAW_ACTION':
                    console.log('Broadcasting draw action:', data.action);
                    // Broadcast drawing actions to all other clients
                    broadcastToOthers(ws, {
                        type: 'DRAW_ACTION',
                        action: data.action
                    });
                    break;

                case 'AI_PROMPT':
                    console.log('\n🤖 Processing AI prompt:', data.prompt);
                    // Store the original prompt for continuation or streaming
                    ws.originalPrompt = data.prompt;
                    // Reset phase to 1 for new drawings
                    ws.currentPhase = 1;
                    currentDrawingPhase = 1;
                    
                    // If streaming mode is active, handle differently
                    if (data.streamingMode) {
                        console.log('Starting streaming mode drawing session');
                        // Enable streaming mode for this client
                        ws.streamingMode = true;
                        toggleStreamingMode(true);
                        
                        // Send initial status to client
                        ws.send(JSON.stringify({
                            type: 'STREAMING_MODE_STARTED',
                            prompt: data.prompt
                        }));
                        
                        // Request an immediate canvas update to start the process
                        ws.send(JSON.stringify({
                            type: 'REQUEST_CANVAS_UPDATE'
                        }));
                    } else {
                        // Process AI prompt in batch mode (existing behavior)
                        const commands = await processUserPrompt(data.prompt, canvasState);
                        console.log('AI returned commands:', commands.length);
                        
                        await executeCommands(commands, ws);
                        console.log('Finished executing AI commands');
                    }
                    break;

                case 'CONTINUE_DRAWING':
                    console.log('\n🖌️ Continuing the drawing process in phase', ws.currentPhase);
                    if (!ws.originalPrompt) {
                        ws.originalPrompt = "the current drawing";
                    }
                    
                    // If in streaming mode, just request a canvas update
                    if (ws.streamingMode) {
                        console.log('Continuing in streaming mode');
                        ws.send(JSON.stringify({
                            type: 'REQUEST_CANVAS_UPDATE'
                        }));
                    } else {
                        // Request additional drawing commands (batch mode)
                        const continuationCommands = await continueDrawing(
                            canvasState, 
                            ws.originalPrompt, 
                            ws.currentPhase
                        );
                        console.log('AI returned continuation commands:', continuationCommands.length);
                        
                        if (continuationCommands.length > 0) {
                            await executeCommands(continuationCommands, ws);
                            console.log('Finished executing continuation commands');
                        } else {
                            console.log('No continuation commands - drawing may be complete');
                            ws.send(JSON.stringify({
                                type: 'DRAWING_COMPLETE'
                            }));
                        }
                    }
                    break;
                    
                case 'TOGGLE_STREAMING_MODE':
                    console.log('\n🔄 Toggling streaming mode:', data.enabled);
                    ws.streamingMode = data.enabled;
                    toggleStreamingMode(data.enabled);
                    
                    // Update streaming interval if provided
                    if (data.interval) {
                        ws.streamingInterval = Math.max(MIN_STREAMING_INTERVAL, 
                            Math.min(MAX_STREAMING_INTERVAL, data.interval));
                        console.log('Streaming interval set to', ws.streamingInterval, 'ms');
                    }
                    
                    // Update batch size if provided
                    if (data.batchSize) {
                        setStreamingBatchSize(data.batchSize);
                    }
                    
                    ws.send(JSON.stringify({
                        type: 'STREAMING_MODE_UPDATE',
                        enabled: ws.streamingMode,
                        interval: ws.streamingInterval
                    }));
                    break;
            }

            // Update the last canvas update time
            ws.lastCanvasUpdate = Date.now();

        } catch (error) {
            // Add recovery logic
            if (consecutiveErrors > 2) {
                ws.send(JSON.stringify({
                    type: 'AI_RESET',
                    canvasState: canvasState,
                    phase: currentDrawingPhase
                }));
                console.log('Sent recovery reset signal');
            }
            consecutiveErrors++;
            console.error('\n❌ Error processing message:', error.message);
            console.error('Full error:', error);
            ws.send(JSON.stringify({
                type: 'ERROR',
                message: error.message
            }));

            ws.send(JSON.stringify({
                type: 'ERROR',
                message: 'Connection error. Please reconnect.',
                recoverable: consecutiveErrors < MAX_CONSECUTIVE_ERRORS
            }));

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.log('Too many consecutive errors. Disconnecting client.');
                clearConversation();
                ws.terminate();
                consecutiveErrors = 0;
            }
        }
    });

    ws.on('close', () => {
        console.log('\n🔌 Client disconnected');
        connectedClients.delete(ws);
        
        // Clean up any event listeners
        ws.removeAllListeners();
        
        console.log('Remaining connected clients:', connectedClients.size);
    });

    ws.on('error', (error) => {
        console.error('\n❌ WebSocket error:', error);
        connectedClients.delete(ws);
        
        // Clean up any event listeners
        ws.removeAllListeners();
    });

    // Send current canvas state to new client
    if (canvasState) {
        console.log('Sending current canvas state to new client');
        ws.send(JSON.stringify({
            type: 'CANVAS_UPDATE',
            canvasData: canvasState
        }));
    }
});

// Set up the heartbeat interval only once
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            connectedClients.delete(ws);
            ws.removeAllListeners(); // Clean up event listeners
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

// Clean up the interval on server close
wss.on('close', () => {
    clearInterval(heartbeatInterval);
});

async function processCanvasWithAI(canvasState, ws) {
    // Skip if we processed a canvas too recently
    const clientId = ws._socket.remoteAddress + ':' + ws._socket.remotePort;
    const metrics = clientTimingMetrics.get(clientId) || {
        lastAnalysisTime: 0,
        analysisInterval: 2000, // Start with 2 seconds between analyses
        previousAnalysis: null
    };
    
    const now = Date.now();
    if (now - metrics.lastAnalysisTime < metrics.analysisInterval) {
        return; // Too soon for another analysis
    }
    
    // Record start time for performance measurement
    const startTime = process.hrtime();
    
    // Analyze the canvas
    const analysis = await analyzeLiveCanvas(canvasState, metrics.previousAnalysis);
    
    if (analysis) {
        // Measure performance
        const [seconds, nanoseconds] = process.hrtime(startTime);
        const processingTime = seconds * 1000 + nanoseconds / 1000000;
        
        // Adjust timing dynamically based on performance
        if (processingTime > 1000) {
            // If processing takes over 1 second, increase interval
            metrics.analysisInterval = Math.min(5000, metrics.analysisInterval * 1.2);
        } else if (processingTime < 500) {
            // If processing is fast, decrease interval
            metrics.analysisInterval = Math.max(1000, metrics.analysisInterval * 0.8);
        }
        
        // Update metrics
        metrics.lastAnalysisTime = now;
        metrics.previousAnalysis = analysis;
        clientTimingMetrics.set(clientId, metrics);
        
        // Send analysis to client
        ws.send(JSON.stringify({
            type: 'AI_ANALYSIS',
            analysis: analysis,
            processingTime: processingTime,
            nextAnalysisIn: metrics.analysisInterval
        }));
        
        // Automatically implement suggestions if completionPercentage < 95
        if (analysis.completionPercentage < 95 && analysis.suggestions && analysis.suggestions.length > 0) {
            // Implement just one suggestion at a time in live mode
            const command = analysis.suggestions[0];
            if (command.endpoint && command.params) {
                ws.send(JSON.stringify({
                    type: command.endpoint.replace('/api/', '').toUpperCase(),
                    ...command.params
                }));
            }
        }
    }
}

function broadcastToOthers(sender, data) {
    console.log(`Broadcasting ${data.type} to other clients...`);
    let broadcastCount = 0;
    connectedClients.forEach(client => {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
            broadcastCount++;
        }
    });
    console.log(`Broadcasted to ${broadcastCount} clients`);
}

// API Endpoints

// Get current canvas state
app.get('/api/canvas', (req, res) => {
    console.log('\n📥 GET /api/canvas');
    res.json({ canvasData: canvasState });
});

// Update canvas with drawing action
app.post('/api/draw', (req, res) => {
    console.log('\n📝 POST /api/draw');
    console.log('Draw action:', req.body);
    
    const action = req.body;
    
    // Broadcast the drawing action to all connected clients
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'DRAW_ACTION',
                action: action
            }));
        }
    });

    res.json({ success: true });
});

app.post('/api/live-mode', (req, res) => {
    console.log('\n🔄 POST /api/live-mode');
    console.log('Live mode:', req.body.enabled);
    
    const { enabled } = req.body;
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.liveAnalysisMode = enabled;
            client.send(JSON.stringify({
                type: 'LIVE_MODE_UPDATE',
                enabled: enabled
            }));
        }
    });

    res.json({ success: true });
});

app.post('/api/streaming-rate', (req, res) => {
    console.log('\n⏱️ POST /api/streaming-rate');
    console.log('New rate:', req.body.rate);
    
    const { rate } = req.body;
    
    // Validate rate (minimum 100ms, maximum 2000ms)
    const validRate = Math.max(100, Math.min(2000, rate));
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.streamingInterval = validRate;
            client.send(JSON.stringify({
                type: 'STREAMING_RATE_UPDATE',
                rate: validRate
            }));
        }
    });

    res.json({ success: true, rate: validRate });
});

// Clear canvas
app.post('/api/clear', (req, res) => {
    console.log('\n🗑️ POST /api/clear');
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'CLEAR_CANVAS'
            }));
        }
    });

    canvasState = null;
    clearConversation(); // Clear AI conversation history when canvas is cleared
    res.json({ success: true });
});

// Change tool
app.post('/api/tool', (req, res) => {
    console.log('\n🔧 POST /api/tool');
    console.log('New tool:', req.body.tool);
    
    const { tool } = req.body;
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'CHANGE_TOOL',
                tool: tool
            }));
        }
    });

    res.json({ success: true });
});

// Change color
app.post('/api/color', (req, res) => {
    console.log('\n🎨 POST /api/color');
    console.log('New color:', req.body.color);
    
    const { color } = req.body;
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'CHANGE_COLOR',
                color: color
            }));
        }
    });

    res.json({ success: true });
});

// Change line width
app.post('/api/linewidth', (req, res) => {
    console.log('\n📏 POST /api/linewidth');
    console.log('New width:', req.body.width);
    
    const { width } = req.body;
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'CHANGE_LINE_WIDTH',
                width: width
            }));
        }
    });

    res.json({ success: true });
});

// Add new API endpoint for streaming mode
app.post('/api/streaming-mode', (req, res) => {
    console.log('\n🌊 POST /api/streaming-mode');
    console.log('Streaming mode:', req.body);
    
    const { enabled, interval, batchSize } = req.body;
    
    // Enable/disable streaming mode globally
    streamingModeEnabled = enabled;
    
    // Set batch size if provided
    if (batchSize) {
        setStreamingBatchSize(batchSize);
    }
    
    // Broadcast to all clients
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.streamingMode = enabled;
            
            // Update interval if provided
            if (interval) {
                client.streamingInterval = Math.max(100, Math.min(2000, interval));
            }
            
            client.send(JSON.stringify({
                type: 'STREAMING_MODE_UPDATE',
                enabled: enabled,
                interval: client.streamingInterval
            }));
        }
    });

    res.json({ 
        success: true, 
        enabled: streamingModeEnabled,
        batchSize: batchSize || 3
    });
});

// Helper function to execute drawing commands
async function executeCommands(commands, ws) {
    // Track if we need to continue drawing
    let shouldContinue = false;
    let completionPercentage = 0;
    let phaseChange = false;
    
    console.log(`Executing ${commands.length} commands...`);
    
    // Add validation layer
    const validatedCommands = commands.map(command => {
        if (command.endpoint === '/api/draw') {
            return {
                ...command,
                params: {
                    tool: command.params.tool || 'pencil',
                    color: validateColor(command.params.color),
                    lineWidth: clamp(command.params.lineWidth, 1, 50),
                    startX: clamp(command.params.startX, 0, 800),
                    startY: clamp(command.params.startY, 0, 600),
                    x: clamp(command.params.x, 0, 800),
                    y: clamp(command.params.y, 0, 600)
                }
            };
        }
        return command;
    });
    
    // Use validatedCommands instead of raw commands
    for (const command of validatedCommands) {
        if (command.endpoint && command.params) {
            console.log('Executing command:', command.endpoint, JSON.stringify(command.params));
            
            // Check if this is a next_phase command
            if (command.endpoint === '/api/next_phase') {
                const completedPhase = command.params.completedPhase || ws.currentPhase;
                const nextPhase = completedPhase + 1;
                
                if (nextPhase <= 3) {
                    ws.currentPhase = nextPhase;
                    currentDrawingPhase = nextPhase;
                    const completionPercentage = command.params.completionPercentage || 0;
                    
                    console.log(`🔄 Advancing to Phase ${nextPhase} (${completionPercentage}% complete)`);
                    
                    // Notify clients of phase change
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'PHASE_CHANGE',
                                phase: nextPhase,
                                completionPercentage: completionPercentage
                            }));
                        }
                    });
                    
                    // Pause briefly to allow UI updates
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Automatically continue to the next phase
                    shouldContinue = true;
                    phaseChange = true;
                }
                continue;
            }
            
            // Check if this is a continue command
            if (command.endpoint === '/api/continue') {
                shouldContinue = true;
                const completionPercentage = command.params.completionPercentage || 0;
                
                // Update phase if specified
                if (command.params.currentPhase) {
                    ws.currentPhase = command.params.currentPhase;
                    currentDrawingPhase = command.params.currentPhase;
                }
                
                console.log(`Drawing completion: ${completionPercentage}%, Phase: ${ws.currentPhase}`);
                
                // Send completion status to client
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'COMPLETION_UPDATE',
                            percentage: completionPercentage,
                            phase: ws.currentPhase
                        }));
                    }
                });
                
                // If completion is less than 95%, schedule continuation
                if (completionPercentage < 95) {
                    console.log('Drawing is incomplete, will continue...');
                } else {
                    console.log('Drawing is nearly complete!');
                    shouldContinue = false;
                }
                continue;
            }
            
            // Execute each command
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    // Map the endpoint to the client-expected message type
                    let messageType;
                    switch (command.endpoint) {
                        case '/api/clear':
                            messageType = 'CLEAR_CANVAS';
                            client.send(JSON.stringify({ type: messageType }));
                            break;
                        case '/api/tool':
                            messageType = 'CHANGE_TOOL';
                            client.send(JSON.stringify({ 
                                type: messageType,
                                tool: command.params.tool 
                            }));
                            break;
                        case '/api/color':
                            messageType = 'CHANGE_COLOR';
                            client.send(JSON.stringify({ 
                                type: messageType,
                                color: command.params.color 
                            }));
                            break;
                        case '/api/linewidth':
                            messageType = 'CHANGE_LINE_WIDTH';
                            client.send(JSON.stringify({ 
                                type: messageType,
                                width: command.params.width 
                            }));
                            break;
                        case '/api/draw':
                            messageType = 'DRAW_ACTION';
                            client.send(JSON.stringify({ 
                                type: messageType,
                                action: command.params
                            }));
                            break;
                        case '/api/pause':
                            messageType = 'PAUSE';
                            client.send(JSON.stringify({ 
                                type: messageType,
                                duration: command.params.duration 
                            }));
                            console.log(`Pausing for ${command.params.duration}ms to capture canvas state`);
                            break;
                        default:
                            console.log('Unknown command endpoint:', command.endpoint);
                    }
                    console.log(`Sent ${messageType} to client`);
                }
            });
            // Add delay between commands
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Add additional delay for pause command
            if (command.endpoint === '/api/pause') {
                console.log('Waiting for canvas state update...');
                await new Promise(resolve => setTimeout(resolve, command.params.duration || 1000));
                
                // If we've paused and should continue based on previous continue command
                if (shouldContinue && completionPercentage < 95) {
                    console.log('Auto-continuing drawing after pause...');
                    
                    // If phase has changed, we need special handling
                    if (phaseChange) {
                        console.log(`Starting phase ${ws.currentPhase} drawing...`);
                        phaseChange = false;
                    }
                    
                    // We'll trigger the continue drawing logic in the client
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'TRIGGER_CONTINUE',
                                phase: ws.currentPhase
                            }));
                        }
                    });
                    
                    // Reset flag to avoid multiple continuations from one command
                    shouldContinue = false;
                }
            }
        }
    }
    console.log('Command execution complete');
}

// Helper functions
const clamp = (value, min, max) => 
    Math.round(Math.max(min, Math.min(max, Number(value) || 0)));
const validateColor = (color) => 
    /^#[0-9A-F]{6}$/i.test(color) ? color : '#000000';

// Intelligent function to process the next queued canvas update
async function processNextCanvasUpdate() {
    // Check if there's anything in the queue
    if (canvasUpdateQueue.size === 0) {
        console.log('Canvas update queue empty');
        return;
    }
    
    // Get the next client from the queue
    const [ws, updateData] = canvasUpdateQueue.entries().next().value;
    
    // Clear this client's entry from the queue
    canvasUpdateQueue.delete(ws);
    
    // Only process if we have a valid client and it's in streaming mode
    if (ws && ws.readyState === WebSocket.OPEN && ws.streamingMode && ws.originalPrompt) {
        // Mark as processing to prevent multiple simultaneous executions
        ws.isProcessingCommand = true;
        
        try {
            // Notify client we're starting command execution
            ws.send(JSON.stringify({
                type: 'STREAMING_COMMAND_START'
            }));
            
            const startTime = Date.now();
            
            // Get AI commands for the current canvas state
            const streamingCommands = await streamingModeUpdate(
                updateData.canvasData, 
                ws.originalPrompt, 
                ws.currentPhase
            );
            
            if (streamingCommands && streamingCommands.length > 0) {
                console.log(`Executing ${streamingCommands.length} streaming commands`);
                await executeCommands(streamingCommands, ws);
                
                // Notify client that command execution is complete
                ws.send(JSON.stringify({
                    type: 'STREAMING_COMMAND_COMPLETE'
                }));
            } else {
                console.log('No streaming commands received or drawing complete');
                ws.streamingMode = false;
                ws.send(JSON.stringify({
                    type: 'STREAMING_COMPLETE'
                }));
            }
            
            // Dynamically adjust streaming interval based on processing time
            const processingTime = Date.now() - startTime;
            ws.streamingInterval = Math.max(
                MIN_STREAMING_INTERVAL,
                Math.min(MAX_STREAMING_INTERVAL, processingTime * 1.2)
            );
            console.log(`Adjusted streaming interval to ${ws.streamingInterval}ms based on processing time of ${processingTime}ms`);
            
        } catch (error) {
            console.error('Error processing canvas update:', error);
            ws.send(JSON.stringify({
                type: 'ERROR',
                message: 'Error processing canvas update: ' + error.message
            }));
        } finally {
            // Mark as no longer processing
            ws.isProcessingCommand = false;
            
            // Check if there are more updates in the queue (from any client)
            if (canvasUpdateQueue.size > 0) {
                console.log('Processing next queued canvas update');
                setTimeout(processNextCanvasUpdate, 100); // Short delay before processing next update
            }
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
}); 