const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Set canvas size
canvas.width = 800;
canvas.height = 600;

// WebSocket connection
const ws = new WebSocket(`ws://${window.location.hostname}:3000`);

// Drawing state
let isDrawing = false;
let currentTool = 'pencil';
let startX = 0;
let startY = 0;
let drawingActions = [];
let lastDrawingState = null;

// Tool elements
const tools = document.querySelectorAll('.tool');
const colorPicker = document.getElementById('colorPicker');
const lineWidthInput = document.getElementById('lineWidth');
const clearButton = document.getElementById('clear');
const saveButton = document.getElementById('save');

// AI Control elements
const aiPrompt = document.getElementById('aiPrompt');
const sendPromptButton = document.getElementById('sendPrompt');

// Default settings
ctx.strokeStyle = colorPicker.value;
ctx.lineWidth = lineWidthInput.value;
ctx.lineCap = 'round';

// WebSocket event handlers
ws.onopen = () => {
    console.log('Connected to server');
};

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('Received WebSocket message:', data);
    
    switch (data.type) {
        case 'CANVAS_UPDATE':
            console.log('Loading canvas state');
            loadCanvasState(data.canvasData);
            break;
        case 'DRAW_ACTION':
            console.log('Executing draw action:', data.action);
            executeDrawAction(data.action);
            break;
        case 'CLEAR_CANVAS':
            console.log('Clearing canvas');
            clearCanvas();
            break;
        case 'CHANGE_TOOL':
            console.log('Changing tool to:', data.tool);
            setTool(data.tool);
            break;
        case 'CHANGE_COLOR':
            console.log('Changing color to:', data.color);
            setColor(data.color);
            break;
        case 'CHANGE_LINE_WIDTH':
            console.log('Changing line width to:', data.width);
            setLineWidth(data.width);
            break;
        case 'PAUSE':
            console.log('Pausing to analyze canvas for', data.duration, 'ms');
            // After a brief pause, send the current canvas state back to server
            setTimeout(() => {
                sendCanvasState();
                console.log('Canvas state sent after pause');
            }, data.duration || 1000);
            break;
        case 'ERROR':
            console.error('Server error:', data.message);
            alert('Error: ' + data.message);
            break;
        default:
            console.warn('Unknown message type:', data.type);
    }

    // Re-enable AI controls after any message
    aiPrompt.disabled = false;
    sendPromptButton.disabled = false;
};

ws.onerror = (error) => {
    console.error('WebSocket error:', error);
};

// Tool selection
tools.forEach(tool => {
    tool.addEventListener('click', (e) => {
        setTool(e.target.id);
        // Notify server about tool change
        fetch('/api/tool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: e.target.id })
        });
    });
});

function setTool(toolId) {
    currentTool = toolId;
    tools.forEach(t => t.classList.remove('active'));
    document.getElementById(toolId).classList.add('active');
}

// Color picker
colorPicker.addEventListener('input', (e) => {
    setColor(e.target.value);
    // Notify server about color change
    fetch('/api/color', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: e.target.value })
    });
});

function setColor(color) {
    ctx.strokeStyle = color;
    colorPicker.value = color;
}

// Line width
lineWidthInput.addEventListener('input', (e) => {
    setLineWidth(e.target.value);
    // Notify server about line width change
    fetch('/api/linewidth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width: e.target.value })
    });
});

function setLineWidth(width) {
    ctx.lineWidth = width;
    lineWidthInput.value = width;
}

// Clear canvas
clearButton.addEventListener('click', () => {
    fetch('/api/clear', { method: 'POST' });
    clearCanvas();
});

function clearCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawingActions = [];
    lastDrawingState = null;
}

// Save canvas
saveButton.addEventListener('click', () => {
    const link = document.createElement('a');
    link.download = 'my-paint-image.png';
    link.href = canvas.toDataURL();
    link.click();
});

// Drawing functions
function startDrawing(e) {
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    
    if (currentTool === 'pencil' || currentTool === 'brush' || currentTool === 'eraser') {
        ctx.beginPath();
        ctx.moveTo(startX, startY);
    }
}

function draw(e) {
    if (!isDrawing) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const drawAction = {
        tool: currentTool,
        color: ctx.strokeStyle,
        lineWidth: ctx.lineWidth,
        startX,
        startY,
        x,
        y
    };

    executeDrawAction(drawAction);
    
    // Send drawing action to server
    ws.send(JSON.stringify({
        type: 'DRAW_ACTION',
        action: drawAction
    }));

    // Update starting position for next draw
    startX = x;
    startY = y;
}

function executeDrawAction(action) {
    ctx.save();
    
    ctx.strokeStyle = action.color;
    ctx.lineWidth = action.lineWidth;

    if (action.tool === 'eraser') {
        ctx.strokeStyle = '#ffffff';
    }

    switch (action.tool) {
        case 'pencil':
        case 'brush':
        case 'eraser':
            ctx.beginPath();
            ctx.moveTo(action.startX, action.startY);
            ctx.lineTo(action.x, action.y);
            ctx.stroke();
            break;
        case 'rectangle':
            ctx.beginPath();
            ctx.rect(action.startX, action.startY, action.x - action.startX, action.y - action.startY);
            ctx.stroke();
            break;
        case 'circle':
            const radius = Math.sqrt(
                Math.pow(action.x - action.startX, 2) + 
                Math.pow(action.y - action.startY, 2)
            );
            ctx.beginPath();
            ctx.arc(action.startX, action.startY, radius, 0, Math.PI * 2);
            ctx.stroke();
            break;
    }

    ctx.restore();
    
    // Store the action
    drawingActions.push(action);
}

function stopDrawing() {
    if (!isDrawing) return;
    isDrawing = false;
    
    // Send canvas state to server
    sendCanvasState();
}

function loadCanvasState(canvasData) {
    if (!canvasData) return;
    
    const img = new Image();
    img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
    };
    img.src = canvasData;
}

// Capture canvas state periodically for LLM analysis
setInterval(() => {
    const currentState = canvas.toDataURL();
    if (currentState !== lastDrawingState) {
        lastDrawingState = currentState;
        // You can send this state to your LLM service (e.g., Gemini) here
        // Example: sendToLLM(currentState);
    }
}, 1000); // Capture every second

// Event listeners for drawing
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);
canvas.addEventListener('mouseout', stopDrawing);

// Touch support
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousedown', {
        clientX: touch.clientX,
        clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvent);
});

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousemove', {
        clientX: touch.clientX,
        clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvent);
});

canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    const mouseEvent = new MouseEvent('mouseup', {});
    canvas.dispatchEvent(mouseEvent);
});

// AI interaction
sendPromptButton.addEventListener('click', () => {
    const prompt = aiPrompt.value.trim();
    if (!prompt) return;

    // Disable input while processing
    aiPrompt.disabled = true;
    sendPromptButton.disabled = true;

    // Send prompt to server
    ws.send(JSON.stringify({
        type: 'AI_PROMPT',
        prompt: prompt
    }));

    // Clear prompt
    aiPrompt.value = '';
});

// Function to send canvas state to server
function sendCanvasState() {
    const canvasData = canvas.toDataURL();
    ws.send(JSON.stringify({
        type: 'CANVAS_UPDATE',
        canvasData: canvasData
    }));
} 