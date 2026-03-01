# AI Painter Live

AI Painter Live is a browser-based paint app where an autonomous LLM paints by calling local drawing tools and requesting screenshots on demand.

## Current Architecture

- Frontend (`index.html`, `styles.css`, `script.js`)
  - Human drawing tools (pencil, brush, rectangle, circle, fill, spray, eraser)
  - AI run controls (prompt, model, temperature, time limit, stop button)
  - Browser-to-local WebSocket connection
  - Local tool runtime for model function calls
  - Deterministic run log and replay
  - Automatic run artifact persistence trigger at run end
- Backend (`server.js`)
  - Static file hosting
  - Local WebSocket proxy at `/ws/responses` that connects to OpenAI Responses API WebSocket mode (`wss://api.openai.com/v1/responses`) with server-side auth
  - Run persistence API (`POST /api/runs/save`) that writes logs and images to disk
  - Run index API (`GET /api/runs/index`) for historical tracking

## Safety + Control Guards

- Single AI painter session at a time
- Exclusive control mode: `Human` or `AI` (not both)
- Manual stop button
- Hard max run timer (seconds)
- `finish` tool for model-controlled termination
- `clear_canvas` tool is blocked by default (must be manually enabled)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` in project root:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_RESPONSES_MODEL=gpt-5.2
PORT=3000
```

3. Start the app:

```bash
npm start
```

4. Open:

`http://localhost:3000`

## Running an AI Paint Session

1. Enter prompt.
2. Set model, temperature, and max run seconds.
3. Click `Start AI Run`.
4. Click `Stop` at any time to cancel.
5. After completion, artifacts are autosaved under `logs/`:
   - `logs/[model]_[YYYYMMDD_HHMMSS].json`
   - `logs/images/[model]_[YYYYMMDD_HHMMSS]_final.png`
   - `logs/images/[model]_[YYYYMMDD_HHMMSS]_shot_###.jpg` (AI screenshot checkpoints)
   - `logs/run_index.jsonl` (one metadata row per run)
6. Optional local actions in UI:
   - `Download Last Run Log`
   - `Replay Last Run`

## Notes

- OpenAI API authentication stays server-side in the WS proxy; the browser never receives your API key.
- Run logs sanitize image payloads in event traces to avoid large data blobs.
- Replay uses recorded draw actions and deterministic seeded spray behavior.
- Server-side autosave stores full run JSON and image artifacts for future analysis.
