const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { processUserPrompt, clearConversation } = require('./services/gemini');

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

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('\n🔌 New client connected');
    console.log('Total connected clients:', connectedClients.size + 1);
    connectedClients.add(ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('\n📩 Received WebSocket message:', data.type);
            
            switch (data.type) {
                case 'CANVAS_UPDATE':
                    console.log('Updating canvas state...');
                    canvasState = data.canvasData;
                    // Broadcast to all other clients
                    broadcastToOthers(ws, {
                        type: 'CANVAS_UPDATE',
                        canvasData: canvasState
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
                    // Process AI prompt and execute commands
                    const commands = await processUserPrompt(data.prompt, canvasState);
                    console.log('AI returned commands:', commands.length);
                    
                    for (const command of commands) {
                        if (command.endpoint && command.params) {
                            console.log('Executing command:', command.endpoint);
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
                            }
                        }
                    }
                    console.log('Finished executing AI commands');
                    break;
            }
        } catch (error) {
            console.error('\n❌ Error processing message:', error.message);
            console.error('Full error:', error);
            ws.send(JSON.stringify({
                type: 'ERROR',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log('\n🔌 Client disconnected');
        connectedClients.delete(ws);
        console.log('Remaining connected clients:', connectedClients.size);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
}); 