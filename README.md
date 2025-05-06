# AI Painter Live

AI Painter Live is a conceptual project focused on augmenting AI art creation through live visual feedback. It allows users to draw on a shared canvas and interact with a generative AI to collaboratively produce artwork.

## Core Features

-   **Interactive Canvas**: Provides standard drawing tools such as pencil, brush, shape tools (rectangle, circle), fill, spray, and an eraser.
-   **Customization**: Users can select colors and adjust line widths.
-   **AI Collaboration**: Users can input text prompts to guide a generative AI (powered by Google's Generative AI SDK) in drawing on the canvas.
-   **Real-time Updates**: Changes made by users or the AI are reflected in real-time for all connected clients.

## Technical Overview

The application is structured as follows:

*   **Frontend**: (`index.html`, `script.js`, `styles.css`) - The client-side interface built with HTML, CSS, and JavaScript. It manages user interactions, local drawing operations, and WebSocket communication with the backend.
*   **Backend**: (`server.js`) - A Node.js server using Express. It handles WebSocket connections (`ws`) for real-time bidirectional communication, manages canvas state, and interfaces with the AI service.
*   **AI Service Integration**: (`services/gemini.js`) - This module is responsible for communicating with Google's Generative AI SDK, processing user prompts, and translating AI responses into drawable commands.
*   **Real-time Streaming**: The application supports a streaming mode where the AI can provide drawing instructions more continuously based on canvas updates, allowing for more fluid interaction.

## Setup and Execution

To run the project locally:

1.  **Prerequisites**: Ensure Node.js is installed.
2.  **Clone Repository**: Obtain a local copy of the project.
3.  **Install Dependencies**: Navigate to the project directory and run `npm install`. This will install necessary packages including Express, ws, and the Google Generative AI SDK.
4.  **API Key Configuration**: A Google AI API key is required. The `.gitignore` file indicates the use of a `.env` file for environment variables. Create a `.env` file in the root directory and add your API key (e.g., `API_KEY=YOUR_API_KEY_HERE`). Refer to `services/gemini.js` for the specific environment variable name if needed.
5.  **Start Server**: Execute `npm start` to run the application. For development with automatic server restarts on file changes, use `npm run dev`.
6.  **Access Application**: Open a web browser and navigate to the specified local address (typically `http://localhost:3000`).

## Key Code Components

For those interested in exploring the codebase:

*   `script.js`: Contains the client-side logic for drawing, UI event handling, and WebSocket message processing.
*   `server.js`: Implements the backend server, WebSocket management, and coordination of AI drawing commands.
*   `services/gemini.js`: Houses the integration with the Google Generative AI service.
*   `index.html`: Defines the structure of the web interface.