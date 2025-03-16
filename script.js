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
let streamingMode = false;
let canvasUpdateInterval = null;
let isProcessingStreamingCommand = false;
let lastUpdateTimestamp = 0;
let minUpdateInterval = 500;

// Tool elements
const tools = document.querySelectorAll('.tool');
const colorPicker = document.getElementById('colorPicker');
const lineWidthInput = document.getElementById('lineWidth');
const clearButton = document.getElementById('clear');
const saveButton = document.getElementById('save');

// AI Control elements
const aiPrompt = document.getElementById('aiPrompt');
const sendPromptButton = document.getElementById('sendPrompt');

// Add streaming mode toggle
let streamingModeToggle = document.createElement('div');
streamingModeToggle.innerHTML = `
    <div class="control-group streaming-controls">
        <label for="streamingModeCheckbox">Streaming Mode</label>
        <input type="checkbox" id="streamingModeCheckbox">
        <div class="streaming-options" style="display: none;">
            <div>
                <label for="streamingInterval">Update Interval (ms):</label>
                <input type="range" id="streamingInterval" min="100" max="1000" step="50" value="300">
                <span id="streamingIntervalValue">300ms</span>
            </div>
            <div>
                <label for="streamingBatchSize">Batch Size:</label>
                <input type="range" id="streamingBatchSize" min="1" max="5" step="1" value="3">
                <span id="streamingBatchSizeValue">3 commands</span>
            </div>
        </div>
    </div>
`;
document.querySelector('.ai-control').appendChild(streamingModeToggle);

// Get references to new controls
const streamingModeCheckbox = document.getElementById('streamingModeCheckbox');
const streamingInterval = document.getElementById('streamingInterval');
const streamingIntervalValue = document.getElementById('streamingIntervalValue');
const streamingBatchSize = document.getElementById('streamingBatchSize');
const streamingBatchSizeValue = document.getElementById('streamingBatchSizeValue');
const streamingOptions = document.querySelector('.streaming-options');

// Add event listeners for streaming controls
streamingModeCheckbox.addEventListener('change', (e) => {
    streamingMode = e.target.checked;
    streamingOptions.style.display = streamingMode ? 'block' : 'none';
    
    // Only update server when toggled manually (not during initial page load)
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'TOGGLE_STREAMING_MODE',
            enabled: streamingMode,
            interval: parseInt(streamingInterval.value),
            batchSize: parseInt(streamingBatchSize.value)
        }));
    }
    
    updateStreamingStatus();
});

streamingInterval.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    streamingIntervalValue.textContent = `${value}ms`;
    
    if (streamingMode && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'TOGGLE_STREAMING_MODE',
            enabled: streamingMode,
            interval: value,
            batchSize: parseInt(streamingBatchSize.value)
        }));
    }
});

streamingBatchSize.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    streamingBatchSizeValue.textContent = `${value} command${value !== 1 ? 's' : ''}`;
    
    if (streamingMode && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'TOGGLE_STREAMING_MODE',
            enabled: streamingMode,
            interval: parseInt(streamingInterval.value),
            batchSize: value
        }));
    }
});

// Update UI to show streaming status
function updateStreamingStatus() {
    const statusEl = document.getElementById('streamingStatus') || (() => {
        const el = document.createElement('div');
        el.id = 'streamingStatus';
        el.style.position = 'absolute';
        el.style.top = '10px';
        el.style.right = '10px';
        el.style.background = 'rgba(0,0,0,0.7)';
        el.style.color = 'white';
        el.style.padding = '5px 10px';
        el.style.borderRadius = '5px';
        el.style.zIndex = '1000';
        document.querySelector('.container').appendChild(el);
        return el;
    })();
    
    if (streamingMode) {
        statusEl.textContent = '🔄 Streaming Mode: Active';
        statusEl.style.display = 'block';
        
        // Highlight active inputs when in streaming mode
        aiPrompt.classList.add('streaming-active');
        sendPromptButton.classList.add('streaming-active');
    } else {
        statusEl.style.display = 'none';
        aiPrompt.classList.remove('streaming-active');
        sendPromptButton.classList.remove('streaming-active');
    }
}

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
            // Make sure action has all needed properties
            if (data.action && (data.action.startX !== undefined || data.action.x !== undefined)) {
                executeDrawAction(data.action);
            } else {
                console.error('Invalid draw action received:', data.action);
            }
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
        case 'TRIGGER_CONTINUE':
            console.log('Server requested to continue drawing');
            // Get the current phase from the message if provided
            const currentPhase = data.phase || 1;
            
            // Send a continue drawing message back to server
            ws.send(JSON.stringify({
                type: 'CONTINUE_DRAWING'
            }));
            
            // Show drawing continuation status with phase info
            showDrawingStatus(`AI continuing to draw in Phase ${currentPhase}...`);
            break;
        case 'PHASE_CHANGE':
            console.log('Phase changed to:', data.phase, 'Completion:', data.completionPercentage, '%');
            showPhaseTransition(data.phase);
            updateCompletionProgress(data.completionPercentage, data.phase);
            break;
        case 'COMPLETION_UPDATE':
            console.log('Drawing progress update:', data.percentage, '%');
            updateCompletionProgress(data.percentage, data.phase);
            break;
        case 'DRAWING_COMPLETE':
            console.log('Drawing complete!');
            showDrawingStatus('Drawing complete!');
            // Re-enable AI controls
            aiPrompt.disabled = false;
            sendPromptButton.disabled = false;
            break;
        case 'ERROR':
            console.error('Error:', data.message);
            showDrawingStatus(`Error: ${data.message}`);
            alert('Error: ' + data.message);
            break;
        case 'STREAMING_MODE_UPDATE':
            console.log('Streaming mode update:', data);
            // Update UI controls without triggering change events
            streamingMode = data.enabled;
            streamingModeCheckbox.checked = streamingMode;
            
            if (data.interval) {
                streamingInterval.value = data.interval;
                streamingIntervalValue.textContent = `${data.interval}ms`;
            }
            
            streamingOptions.style.display = streamingMode ? 'block' : 'none';
            updateStreamingStatus();
            break;
            
        case 'STREAMING_MODE_STARTED':
            console.log('Streaming mode started for prompt:', data.prompt);
            showDrawingStatus('AI starting to draw in streaming mode...');
            
            // Start sending canvas updates more frequently, but with throttling
            if (canvasUpdateInterval) {
                clearInterval(canvasUpdateInterval);
            }
            
            const interval = parseInt(streamingInterval.value);
            lastUpdateTimestamp = Date.now();
            canvasUpdateInterval = setInterval(() => {
                // Only send updates if not currently processing and enough time has passed
                if (streamingMode && !isProcessingStreamingCommand && 
                    (Date.now() - lastUpdateTimestamp >= minUpdateInterval)) {
                    lastUpdateTimestamp = Date.now();
                    sendCanvasState();
                    console.log('Canvas state automatically updated');
                }
            }, interval);
            break;
            
        case 'STREAMING_COMPLETE':
            console.log('Streaming drawing complete');
            showDrawingStatus('Streaming drawing complete!');
            
            // Stop frequent canvas updates
            if (canvasUpdateInterval) {
                clearInterval(canvasUpdateInterval);
                canvasUpdateInterval = null;
            }
            
            // Re-enable AI controls
            aiPrompt.disabled = false;
            sendPromptButton.disabled = false;
            streamingMode = false;
            updateStreamingStatus();
            break;
            
        case 'REQUEST_CANVAS_UPDATE':
            console.log('Server requested canvas update');
            // Send the current canvas state immediately
            sendCanvasState();
            break;
        
        case 'STREAMING_COMMAND_START':
            console.log('Server processing streaming command');
            isProcessingStreamingCommand = true;
            // Add a visual indicator that commands are being processed
            showDrawingStatus('Processing streaming commands...');
            break;
        
        case 'STREAMING_COMMAND_COMPLETE':
            console.log('Server completed streaming command batch');
            isProcessingStreamingCommand = false;
            // Show that commands have been processed
            showDrawingStatus('Drawing updated. Resuming streaming...');
            // Allow a short delay before sending next update
            setTimeout(() => {
                lastUpdateTimestamp = Date.now() - minUpdateInterval;
                // Explicitly send a canvas update to continue the streaming flow
                if (streamingMode) {
                    sendCanvasState();
                    console.log('Sending canvas update after command completion');
                }
            }, 200);
            break;
        
        default:
            console.warn('Unknown message type:', data.type);
    }
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
    
    if (currentTool === 'fill') {
        // For fill tool, execute immediately on click
        const drawAction = {
            tool: 'fill',
            color: ctx.strokeStyle,
            lineWidth: ctx.lineWidth,
            startX,
            startY,
            x: startX,
            y: startY
        };
        
        executeDrawAction(drawAction);
        
        // Send the action to server
        ws.send(JSON.stringify({
            type: 'DRAW_ACTION',
            action: drawAction
        }));
    } else if (currentTool === 'pencil' || currentTool === 'brush' || currentTool === 'eraser') {
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

    // Special handling for spray tool (continuous effect)
    if (currentTool === 'spray') {
        executeDrawAction(drawAction);
        // For spray, we don't update startX/startY to create a new spray point each time
    } else if (currentTool === 'fill') {
        // For fill tool, we only execute on mousedown, not during mouse movement
        // This is handled in startDrawing
    } else {
        executeDrawAction(drawAction);
        // Update starting position for next draw
        startX = x;
        startY = y;
    }
    
    // Send drawing action to server
    ws.send(JSON.stringify({
        type: 'DRAW_ACTION',
        action: drawAction
    }));

    // For non-spray tools, update the starting position
    if (currentTool !== 'spray') {
        startX = x;
        startY = y;
    }
}

function executeDrawAction(action) {
    console.log('Executing draw action:', action);
    
    // Set tool, color, and line width based on the action
    if (action.tool) {
        setTool(action.tool);
    }
    
    if (action.color) {
        setColor(action.color);
    }
    
    if (action.lineWidth) {
        setLineWidth(action.lineWidth);
    }
    
    // Always use the values from the action for the actual drawing, not the current client state
    const actionTool = action.tool || currentTool;
    const actionColor = action.color || ctx.strokeStyle;
    const actionWidth = action.lineWidth || ctx.lineWidth;
    
    // Debug info - remove after verification
    console.log(`Drawing with tool: ${actionTool}, color: ${actionColor}, width: ${actionWidth}`);
    console.log(`Start: (${action.startX}, ${action.startY}), End: (${action.x}, ${action.y})`);
    
    switch (actionTool) {
        case 'pencil':
            ctx.beginPath();
            ctx.strokeStyle = actionColor;
            ctx.lineWidth = actionWidth;
            ctx.moveTo(action.startX, action.startY);
            ctx.lineTo(action.x, action.y);
            ctx.stroke();
            break;
            
        case 'brush':
            ctx.beginPath();
            ctx.strokeStyle = actionColor;
            ctx.lineWidth = actionWidth;
            ctx.lineCap = 'round';
            ctx.moveTo(action.startX, action.startY);
            ctx.lineTo(action.x, action.y);
            ctx.stroke();
            break;
            
        case 'rectangle':
            const rectWidth = action.x - action.startX;
            const rectHeight = action.y - action.startY;
            ctx.beginPath();
            ctx.strokeStyle = actionColor;
            ctx.lineWidth = actionWidth;
            ctx.rect(action.startX, action.startY, rectWidth, rectHeight);
            ctx.stroke();
            break;
            
        case 'circle':
            const radius = Math.sqrt(Math.pow(action.x - action.startX, 2) + Math.pow(action.y - action.startY, 2));
            ctx.beginPath();
            ctx.strokeStyle = actionColor;
            ctx.lineWidth = actionWidth;
            ctx.arc(action.startX, action.startY, radius, 0, 2 * Math.PI);
            ctx.stroke();
            break;
            
        case 'fill':
            ctx.fillStyle = actionColor;
            floodFill(action.startX, action.startY, actionColor);
            break;
            
        case 'spray':
            ctx.fillStyle = actionColor;
            sprayPaint(action.x, action.y, actionWidth * 2, actionWidth * 5, actionColor);
            break;
            
        case 'eraser':
            ctx.beginPath();
            ctx.strokeStyle = '#FFFFFF'; // White for eraser
            ctx.lineWidth = actionWidth;
            ctx.lineCap = 'round';
            ctx.moveTo(action.startX, action.startY);
            ctx.lineTo(action.x, action.y);
            ctx.stroke();
            break;
    }
    
    // After drawing, save the canvas state for periodic updates
    lastDrawingState = canvas.toDataURL();
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

    // Show drawing status based on mode
    if (streamingMode) {
        showDrawingStatus('AI starting to draw in streaming mode...');
        
        // For streaming mode, we don't show phase transitions
        const progressContainer = document.getElementById('progressContainer');
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
    } else {
        // For batch mode, show phase information
        showDrawingStatus('AI starting to draw in Phase 1...');
        
        // Reset any previous progress
        const progressContainer = document.getElementById('progressContainer');
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
        
        // Show initial phase information
        showPhaseTransition(1);
        
        // Initialize progress with Phase 1
        setTimeout(() => {
            updateCompletionProgress(0, 1);
        }, 1000);
    }
    
    // Send prompt to server, indicating if we're in streaming mode
    ws.send(JSON.stringify({
        type: 'AI_PROMPT',
        prompt: prompt,
        streamingMode: streamingMode
    }));

    // Clear prompt
    aiPrompt.value = '';
});

// Function to send canvas state to server
function sendCanvasState() {
    // Don't send if already processing to prevent feedback loops
    if (streamingMode && isProcessingStreamingCommand) {
        console.log('Skipping canvas update while command is processing');
        return;
    }
    
    const canvasData = canvas.toDataURL();
    ws.send(JSON.stringify({
        type: 'CANVAS_UPDATE',
        canvasData: canvasData
    }));
}

// Function to show drawing status
function showDrawingStatus(message) {
    // Check if status element exists, if not create it
    let statusEl = document.getElementById('drawingStatus');
    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'drawingStatus';
        statusEl.style.position = 'absolute';
        statusEl.style.bottom = '10px';
        statusEl.style.left = '10px';
        statusEl.style.background = 'rgba(0,0,0,0.7)';
        statusEl.style.color = 'white';
        statusEl.style.padding = '5px 10px';
        statusEl.style.borderRadius = '5px';
        statusEl.style.zIndex = '1000';
        document.querySelector('.container').appendChild(statusEl);
    }
    
    statusEl.textContent = message;
    
    // Auto-hide after 5 seconds unless it's a continuing message
    if (!message.includes('continuing')) {
        setTimeout(() => {
            statusEl.style.display = 'none';
        }, 5000);
    } else {
        statusEl.style.display = 'block';
    }
}

// Function to show phase transitions with visual feedback
function showPhaseTransition(phase) {
    const phaseNames = {
        1: 'Structure & Outline',
        2: 'Coloring & Filling',
        3: 'Details & Refinement'
    };
    
    const phaseName = phaseNames[phase] || `Phase ${phase}`;
    
    // Create a phase transition overlay
    const overlay = document.createElement('div');
    overlay.id = 'phaseOverlay';
    overlay.style.position = 'absolute';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = 'rgba(0,0,0,0.7)';
    overlay.style.color = 'white';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    overlay.style.fontSize = '24px';
    overlay.style.zIndex = '2000';
    overlay.style.textAlign = 'center';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.5s ease-in-out';
    
    overlay.innerHTML = `
        <div style="font-size: 36px; margin-bottom: 10px;">Phase ${phase}</div>
        <div style="font-size: 24px; margin-bottom: 20px;">${phaseName}</div>
    `;
    
    document.querySelector('.container').appendChild(overlay);
    
    // Fade in the overlay
    setTimeout(() => {
        overlay.style.opacity = '1';
    }, 100);
    
    // Fade out and remove after 2 seconds
    setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        }, 500);
    }, 2000);
}

// Function to update completion progress with phase info
function updateCompletionProgress(percentage, phase) {
    // Check if progress element exists, if not create it
    let progressEl = document.getElementById('completionProgress');
    if (!progressEl) {
        const container = document.createElement('div');
        container.id = 'progressContainer';
        container.style.position = 'absolute';
        container.style.bottom = '40px';
        container.style.left = '10px';
        container.style.width = '200px';
        container.style.background = 'rgba(0,0,0,0.5)';
        container.style.borderRadius = '5px';
        container.style.padding = '5px';
        container.style.zIndex = '1000';
        
        progressEl = document.createElement('div');
        progressEl.id = 'completionProgress';
        progressEl.style.height = '10px';
        progressEl.style.width = '0%';
        progressEl.style.background = 'linear-gradient(to right, #00ff00, #ffff00, #ff0000)';
        progressEl.style.borderRadius = '5px';
        progressEl.style.transition = 'width 0.5s ease-in-out';
        
        const percentText = document.createElement('div');
        percentText.id = 'percentText';
        percentText.style.color = 'white';
        percentText.style.fontSize = '12px';
        percentText.style.textAlign = 'center';
        percentText.style.marginTop = '2px';
        
        const phaseText = document.createElement('div');
        phaseText.id = 'phaseText';
        phaseText.style.color = 'white';
        phaseText.style.fontSize = '12px';
        phaseText.style.textAlign = 'center';
        phaseText.style.marginTop = '2px';
        
        container.appendChild(progressEl);
        container.appendChild(percentText);
        container.appendChild(phaseText);
        document.querySelector('.container').appendChild(container);
    }
    
    // Update progress bar
    progressEl.style.width = `${percentage}%`;
    document.getElementById('percentText').textContent = `${Math.round(percentage)}% complete`;
    
    // Update phase text if provided
    if (phase) {
        const phaseNames = {
            1: 'Structure & Outline',
            2: 'Coloring & Filling',
            3: 'Details & Refinement'
        };
        document.getElementById('phaseText').textContent = `Phase ${phase}: ${phaseNames[phase] || ''}`;
    }
    
    // Show progress bar
    document.getElementById('progressContainer').style.display = 'block';
    
    // Hide when complete
    if (percentage >= 100) {
        setTimeout(() => {
            document.getElementById('progressContainer').style.display = 'none';
        }, 3000);
    }
}

// Function for spray paint tool
function sprayPaint(x, y, radius, density, color) {
    ctx.fillStyle = color;
    
    for (let i = 0; i < density; i++) {
        // Generate random position within the circle
        const angle = Math.random() * 2 * Math.PI;
        const randomRadius = Math.random() * radius;
        const dotX = x + randomRadius * Math.cos(angle);
        const dotY = y + randomRadius * Math.sin(angle);
        
        // Draw a small dot
        ctx.beginPath();
        ctx.arc(dotX, dotY, 1, 0, Math.PI * 2);
        ctx.fill();
    }
}

// Function to perform flood fill (bucket tool)
function floodFill(startX, startY, fillColor) {
    // Get canvas image data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    // Get starting position pixel color
    const startPos = (startY * canvas.width + startX) * 4;
    const startR = data[startPos];
    const startG = data[startPos + 1];
    const startB = data[startPos + 2];
    const startA = data[startPos + 3];
    
    // Convert fill color from hex to RGB
    const fillColorRGB = hexToRgb(fillColor);
    if (!fillColorRGB) return;
    
    // If starting color is the same as fill color, nothing to do
    if (colorsMatch(startR, startG, startB, startA, 
                   fillColorRGB.r, fillColorRGB.g, fillColorRGB.b, 255)) {
        return;
    }
    
    // Queue for flood fill
    const queue = [];
    queue.push([startX, startY]);
    
    // Tolerance for color matching (0-255, higher means more colors will be filled)
    const tolerance = 20;
    
    // Perform flood fill
    while (queue.length > 0) {
        const [x, y] = queue.pop();
        const pos = (y * canvas.width + x) * 4;
        
        // Check if this pixel matches the starting color
        if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height ||
            !colorsMatchWithTolerance(
                data[pos], data[pos + 1], data[pos + 2], data[pos + 3],
                startR, startG, startB, startA,
                tolerance
            )) {
            continue;
        }
        
        // Fill the pixel
        data[pos] = fillColorRGB.r;
        data[pos + 1] = fillColorRGB.g;
        data[pos + 2] = fillColorRGB.b;
        data[pos + 3] = 255; // Full opacity
        
        // Add neighboring pixels to the queue
        queue.push([x + 1, y]);
        queue.push([x - 1, y]);
        queue.push([x, y + 1]);
        queue.push([x, y - 1]);
    }
    
    // Put the modified image data back on the canvas
    ctx.putImageData(imageData, 0, 0);
}

// Helper function to convert hex color to RGB
function hexToRgb(hex) {
    // Remove # if present
    hex = hex.replace(/^#/, '');
    
    // Parse as RGB
    const bigint = parseInt(hex, 16);
    return {
        r: (bigint >> 16) & 255,
        g: (bigint >> 8) & 255,
        b: bigint & 255
    };
}

// Helper function to check if two colors match exactly
function colorsMatch(r1, g1, b1, a1, r2, g2, b2, a2) {
    return r1 === r2 && g1 === g2 && b1 === b2 && a1 === a2;
}

// Helper function to check if two colors match within a tolerance
function colorsMatchWithTolerance(r1, g1, b1, a1, r2, g2, b2, a2, tolerance) {
    return Math.abs(r1 - r2) <= tolerance &&
           Math.abs(g1 - g2) <= tolerance &&
           Math.abs(b1 - b2) <= tolerance &&
           Math.abs(a1 - a2) <= tolerance;
}

// Add some CSS for streaming mode
const streamingStyleSheet = document.createElement('style');
streamingStyleSheet.textContent = `
    .streaming-controls {
        margin-top: 15px;
        border-top: 1px solid #ddd;
        padding-top: 10px;
    }
    
    .streaming-options {
        margin-top: 8px;
        font-size: 0.9em;
        padding-left: 10px;
    }
    
    .streaming-active {
        border-color: #4CAF50 !important;
        box-shadow: 0 0 5px rgba(76, 175, 80, 0.5) !important;
    }
    
    #streamingStatus {
        background: rgba(76, 175, 80, 0.8) !important;
    }
`;
document.head.appendChild(streamingStyleSheet); 