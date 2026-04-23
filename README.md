# TwinMind - Live Suggestions

TwinMind is a browser-based AI meeting copilot that listens to microphone audio, transcribes it in chunks, surfaces three live suggestions, and lets the user click into a longer chat response.

## Stack

- Frontend: vanilla JavaScript, HTML, CSS
- Audio capture: `MediaRecorder` + browser media APIs
- Transcription: Groq Whisper Large V3
- Suggestions and chat: Groq GPT-OSS 120B
- Rendering: client-side only, no backend required

## Run locally

1. Open the app through a local static server.
2. Paste your Groq API key in Settings.
3. Choose an audio source and start recording.

Example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/index.html`.

## Prompt strategy

- Live suggestions use a grounded prompt with transcript signals and explicit type diversity rules.
- Chat uses a separate, longer-form prompt with the full transcript context plus recent summaries.
- Clicked suggestions use a third prompt optimized for turning a preview into the next useful spoken line.
- Settings expose the prompts and context windows so the system can be tuned without code changes.

## Key behaviors

- Transcript chunks are finalized roughly every 30 seconds.
- Refresh flushes the current chunk before recomputing suggestions.
- Suggestion batches are deduped against the full session history, not just the visible cards.
- Export includes transcript chunks with timestamps, rolling summaries, suggestion batches, and chat history.

## Tradeoffs

- The app stays client-only for simplicity and low latency, so the browser handles audio capture and all Groq calls directly.
- I prioritized response quality and grounded suggestions over extra UI complexity.
- The recording pipeline favors stable chunk boundaries and valid media uploads over more experimental optimizations.

## Notes

- No API key is hard-coded.
- Reloading the page resets session state.
- The UI follows the requested three-column prototype layout: transcript, live suggestions, and chat.
