# TwinMind – Real-Time AI Meeting Copilot for Live Decision Support

## Problem Statement

In fast-paced meetings, participants often struggle to process information and respond effectively in real time. This leads to missed insights, delayed responses, and lower-quality communication.

This problem primarily affects:
- Customer support teams
- Sales and client-facing roles
- Cross-functional team meetings

The core issue is cognitive overload during live conversations.

**If solved:**
- Users can respond faster with better context
- Conversations become more productive and actionable

**Success metric:**
- Reduced response latency
- Higher quality and relevance of responses
- Improved meeting efficiency

## Solution Overview

TwinMind is a real-time AI meeting copilot that listens to live audio, transcribes it, and generates context-aware suggestions for what to say next.

**Key Features:**
- Live audio transcription (chunked streaming)
- Real-time suggestion generation (3 diverse suggestions)
- Expandable responses via chat interface
- Session memory with rolling summaries
- Exportable meeting data (transcripts, suggestions, chat)

**Role of AI:**

AI is core to the system, not supplementary.

Without AI: You only get transcription

With AI: You get real-time reasoning + actionable suggestions

This transforms the system from a passive tool → active decision-support system

## AI Integration

**Models & APIs:**
- Groq Whisper Large V3 → transcription
- Groq GPT-OSS 120B → suggestions + chat

**Techniques used:**
- Multi-step LLM pipeline: transcription → summarization → suggestion generation → expansion
- Prompt specialization: separate prompts for suggestions, chat, and expansion
- Context management: rolling summaries + full transcript

**Tradeoffs:**
- Latency vs accuracy → chose chunking (~30s) for stable transcripts
- Client-only vs backend → chose client-only for simplicity, but less secure
- Single vs multiple prompts → chose multiple prompts for better control

**Where AI worked well:**
- High-quality contextual suggestions
- Strong language generation for responses

**Limitations:**
- Latency from chunking
- No true tool execution (not fully agentic yet)

## Architecture / Design Decisions

**System Design:**

Frontend (Browser):
- Audio capture via MediaRecorder
- UI rendering (transcript, suggestions, chat)

Processing Pipeline:
- Audio → chunked recording
- Whisper → transcription
- Context layer → rolling summaries
- LLM → suggestions + chat

**Key Decisions:**
- Client-only architecture for low latency
- Chunk-based processing for reliability
- Prompt modularization for control and tuning

**Tradeoffs:**
- Simpler deployment vs security (API keys in browser)
- Stability vs real-time streaming latency

**What did AI help you do faster, and where did it get in your way?**

Helped:
- Rapid prototyping of LLM pipelines
- Faster iteration on prompt design
- Generating boilerplate UI + integration logic

Limitations:
- Debugging LLM outputs required manual tuning
- Prompt unpredictability required multiple iterations
- AI-generated code sometimes lacked structure and needed refactoring

**Impact:**
AI significantly accelerated development speed, but required careful validation and iteration for reliability.

## Getting Started / Setup Instructions

```bash
git clone <repo-url>
cd twinmind
python -m http.server 8000
```

Then open: `http://localhost:8000/index.html`

**Steps:**
1. Add Groq API key in Settings
2. Select audio input
3. Start recording

## Demo

1. Start recording audio
2. Observe transcript updating in real time
3. View live suggestions generated from context
4. Click suggestions to expand into full responses
5. Use chat panel for deeper interaction

## Testing / Error Handling

**Handled edge cases:**
- Empty or incomplete transcript chunks
- Duplicate suggestions across sessions
- API failures (fallback messaging)

**Deduplication:**
- Suggestions are checked against full session history

**Stability:**
- Chunking ensures valid audio uploads and consistent transcription

## Key behaviors

- Transcript chunks are finalized roughly every 30 seconds
- Refresh flushes the current chunk before recomputing suggestions
- Suggestion batches are deduped against the full session history, not just the visible cards
- Daily GPT token budget enforced (20,000 tokens/day limit)
- Export includes transcript chunks with timestamps, rolling summaries, suggestion batches, and chat history

## Prompt strategy

- Live suggestions use a grounded prompt with transcript signals and explicit type diversity rules
- Chat uses a separate, longer-form prompt with the full transcript context plus recent summaries
- Clicked suggestions use a third prompt optimized for turning a preview into the next useful spoken line
- Settings expose the prompts and context windows so the system can be tuned without code changes

## Stack & Implementation

- Frontend: vanilla JavaScript, HTML, CSS
- Audio capture: `MediaRecorder` + browser media APIs
- Transcription: Groq Whisper Large V3
- Suggestions and chat: Groq GPT-OSS 120B
- Rendering: client-side only, no backend required

## Tradeoffs

- The app stays client-only for simplicity and low latency, so the browser handles audio capture and all Groq calls directly
- Prioritized response quality and grounded suggestions over extra UI complexity
- The recording pipeline favors stable chunk boundaries and valid media uploads over more experimental optimizations

## Future Improvements / Stretch Goals

- Add tool execution layer (generate follow-up emails, extract action items)
- Move to backend architecture for secure API handling
- Implement streaming transcription for lower latency
- Add vector database (RAG) for long-term memory
- Enable integrations with Slack, CRM, or ticketing systems

## Deployment

Live at: **files-psi-steel.vercel.app**

## Notes

- No API key is hard-coded
- Reloading the page resets session state
- The UI follows the requested three-column prototype layout: transcript, live suggestions, and chat
