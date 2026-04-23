/* ── contextMemory.js ──────────────────────────────────────────────────────
   Semantic compression pipeline. Transforms raw transcript chunks into
   three compact, deduplicated memory layers so the LLM receives only
   signal — no filler, no repetition.

   LAYERS
   ──────
   keyFacts    [{id, text, type, ts}]
     Unique entities, numbers, decisions, names, claims extracted per chunk.
     Deduplicated by normalised key so the same fact never appears twice.

   topicThread  string  (≤ 3 sentences)
     A rolling spine of what is being discussed right now.
     Replaced, not appended — stays fixed-size no matter how long the meeting.

   actionMap   [{owner, task, deadline, ts}]
     Structured owner→task→deadline triples extracted from action language.
     Deduplicated by (owner, task) key.

   All extraction is done with regex heuristics — zero extra API calls.
   The module exposes pure functions; state lives in session.contextMemory.
───────────────────────────────────────────────────────────────────────────── */

// ── Type constants ────────────────────────────────────────────────────────

export const FACT_TYPES = {
  DECISION:   'decision',
  NUMBER:     'number',
  NAME:       'name',
  CLAIM:      'claim',
  RISK:       'risk',
  QUESTION:   'question',
  DEADLINE:   'deadline',
  TOOL:       'tool',
};

// ── Public initialiser (call once per session reset) ──────────────────────

export function makeContextMemory() {
  return {
    keyFacts:    [],   // [{id, text, type, ts, chunkIndex}]
    topicThread: '',   // ≤3-sentence spine of current discussion
    actionMap:   [],   // [{owner, task, deadline, ts}]
    _factKeys:   new Set(), // normalised dedup keys
    _actionKeys: new Set(), // normalised dedup keys
  };
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Ingest a new transcript chunk and update all three memory layers.
 * Mutates session.contextMemory in place.
 *
 * @param {object} memory   session.contextMemory
 * @param {string} text     raw chunk text
 * @param {number} chunkIndex
 */
export function ingestChunk(memory, text, chunkIndex) {
  if (!text || !memory) return;

  const sentences = splitSentences(text);

  extractKeyFacts(memory, sentences, chunkIndex);
  updateTopicThread(memory, sentences);
  extractActions(memory, sentences);
}

// ── Layer 1: Key Facts ────────────────────────────────────────────────────

const FACT_PATTERNS = [
  // Decisions
  { re: /\b(?:we(?:'re going to| will| decided to| agreed to| are going to)|let's go with|going with|decided|approved|confirmed|locked in)\s+(.{10,80})/gi, type: FACT_TYPES.DECISION },
  // Numbers with context
  { re: /\b(\d[\d,.]*\s*(?:%|percent|k|million|billion|ms|seconds?|minutes?|hours?|days?|weeks?|months?|users?|requests?|tokens?)?)\b.{0,40}/gi, type: FACT_TYPES.NUMBER },
  // Named people with context
  { re: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:will|said|mentioned|noted|suggested|confirmed|asked|owns|is responsible for|is handling)\s+(.{5,60})/g, type: FACT_TYPES.NAME },
  // Risk / blockers
  { re: /\b(?:risk|blocker|issue|problem|concern|dependency|breaking|failing|blocked by)\b.{0,80}/gi, type: FACT_TYPES.RISK },
  // Explicit questions (keep the question itself)
  { re: /([A-Z][^.!?]*\?)/g, type: FACT_TYPES.QUESTION },
  // Claims with "is" / "are" + number or comparison
  { re: /\b(?:currently|right now|as of|today)\b.{0,60}/gi, type: FACT_TYPES.CLAIM },
  // Tool / tech names: TitleCase or ALL_CAPS tokens ≥4 chars
  { re: /\b([A-Z][a-z]*[A-Z]\w*|[A-Z]{4,})\b/g, type: FACT_TYPES.TOOL },
  // Deadlines
  { re: /\b(?:by|before|due|deadline is?|ship|launch|release)\s+(?:end of\s+)?(?:today|tomorrow|(?:this|next)\s+\w+|\w+day|\w+\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}[\/\-]\d{1,2})\b.{0,40}/gi, type: FACT_TYPES.DEADLINE },
];

function extractKeyFacts(memory, sentences, chunkIndex) {
  const now = Date.now();

  for (const sentence of sentences) {
    if (sentence.split(/\s+/).length < 5) continue; // skip fragments

    for (const { re, type } of FACT_PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(sentence)) !== null) {
        const raw  = match[0].trim();
        const key  = normaliseKey(raw);
        if (key.length < 8) continue;
        if (memory._factKeys.has(key)) continue;

        memory._factKeys.add(key);
        memory.keyFacts.push({
          id:         `f${memory.keyFacts.length}`,
          text:       cleanFact(raw),
          type,
          ts:         now,
          chunkIndex,
        });
      }
    }
  }

  // Cap to last 60 facts (oldest drop off) — prevents unbounded growth
  if (memory.keyFacts.length > 60) {
    const dropped = memory.keyFacts.splice(0, memory.keyFacts.length - 60);
    for (const f of dropped) memory._factKeys.delete(normaliseKey(f.text));
  }
}

// ── Layer 2: Topic Thread ─────────────────────────────────────────────────

/**
 * Keep a 3-sentence spine of the current topic.
 * Strategy: take the last 3 informative (non-filler) sentences from the chunk.
 */
function updateTopicThread(memory, sentences) {
  const informative = sentences
    .filter(s => {
      const words = s.split(/\s+/).length;
      return words >= 6 && !isFiller(s);
    })
    .slice(-3);

  if (informative.length === 0) return;

  // Blend: keep up to 1 sentence from previous thread for continuity
  const prevSentences = splitSentences(memory.topicThread).slice(-1);
  const blended       = [...prevSentences, ...informative].slice(-3);
  memory.topicThread  = blended.join(' ').trim();
}

// ── Layer 3: Action Map ───────────────────────────────────────────────────

const ACTION_PATTERNS = [
  // "John will fix the auth bug by Friday"
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:will|is going to|needs to|should|must|has to)\s+(.{8,60?}?)(?:\s+by\s+(.{4,30}))?[.!,]/g,
  // "Action item: Sarah — update the dashboard"
  /(?:action item|todo|task|follow.?up)\s*[:\-—]\s*(?:([A-Z][a-z]+)\s*[:\-—]\s*)?(.{8,80})/gi,
  // "We need X to do Y"
  /\bwe need\s+([A-Za-z]+)\s+to\s+(.{8,60})/gi,
  // "Let's have X do Y"
  /\blet['']?s (?:have\s+)?([A-Za-z]+)\s+(?:take care of|handle|own|do|review|update|fix|build|set up)\s+(.{5,60})/gi,
];

function extractActions(memory, sentences) {
  const now  = Date.now();
  const text = sentences.join(' ');

  for (const re of ACTION_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const owner    = (match[1] || 'Team').trim();
      const task     = (match[2] || '').trim();
      const deadline = (match[3] || '').trim() || null;
      if (task.length < 6) continue;

      const key = normaliseKey(`${owner}:${task}`);
      if (memory._actionKeys.has(key)) continue;

      memory._actionKeys.add(key);
      memory.actionMap.push({ owner, task: cleanFact(task), deadline, ts: now });
    }
  }

  // Cap to 20 most recent actions
  if (memory.actionMap.length > 20) {
    memory.actionMap.splice(0, memory.actionMap.length - 20);
  }
}

// ── Serialisers — produce compact strings for prompt injection ────────────

/**
 * Render key facts as a compact bullet list, grouped by type.
 * Types are shown in priority order: decisions first, then questions, etc.
 *
 * @param {object} memory
 * @param {object} opts
 * @param {number} opts.maxFacts    cap on total bullets (default 20)
 * @param {number} opts.recencyMs  only include facts newer than this ms ago (0 = all)
 * @param {string[]} opts.types    filter to these types only (default all)
 * @returns {string}
 */
export function serialiseKeyFacts(memory, {
  maxFacts   = 20,
  recencyMs  = 0,
  types      = null,
} = {}) {
  if (!memory?.keyFacts?.length) return '';

  const TYPE_ORDER = [
    FACT_TYPES.DECISION,
    FACT_TYPES.QUESTION,
    FACT_TYPES.RISK,
    FACT_TYPES.ACTION,
    FACT_TYPES.DEADLINE,
    FACT_TYPES.NUMBER,
    FACT_TYPES.CLAIM,
    FACT_TYPES.NAME,
    FACT_TYPES.TOOL,
  ];

  const cutoff = recencyMs > 0 ? Date.now() - recencyMs : 0;
  let facts    = memory.keyFacts.filter(f => {
    if (cutoff && f.ts < cutoff) return false;
    if (types && !types.includes(f.type)) return false;
    return true;
  });

  // Sort by type priority, then recency (newest first within type)
  const order = idx => (TYPE_ORDER.indexOf(idx) + 1) || TYPE_ORDER.length + 1;
  facts.sort((a, b) => {
    const od = order(a.type) - order(b.type);
    return od !== 0 ? od : b.ts - a.ts;
  });

  facts = facts.slice(0, maxFacts);

  // Group by type for readability
  const groups = new Map();
  for (const f of facts) {
    if (!groups.has(f.type)) groups.set(f.type, []);
    groups.get(f.type).push(f.text);
  }

  const TYPE_LABELS = {
    [FACT_TYPES.DECISION]: 'Decisions',
    [FACT_TYPES.QUESTION]: 'Questions asked',
    [FACT_TYPES.RISK]:     'Risks / blockers',
    [FACT_TYPES.DEADLINE]: 'Deadlines',
    [FACT_TYPES.NUMBER]:   'Key numbers',
    [FACT_TYPES.CLAIM]:    'Claims',
    [FACT_TYPES.NAME]:     'People / roles',
    [FACT_TYPES.TOOL]:     'Tools / systems',
  };

  const lines = [];
  for (const type of TYPE_ORDER) {
    const items = groups.get(type);
    if (!items?.length) continue;
    lines.push(`[${TYPE_LABELS[type] || type}]`);
    for (const item of items) lines.push(`• ${item}`);
  }

  return lines.join('\n');
}

/**
 * Render the action map as a compact table-like string.
 * @param {object} memory
 * @param {number} maxActions
 * @returns {string}
 */
export function serialiseActionMap(memory, maxActions = 10) {
  if (!memory?.actionMap?.length) return '';

  const recent = memory.actionMap.slice(-maxActions);
  const lines  = ['[Action Items]'];
  for (const { owner, task, deadline } of recent) {
    const dl = deadline ? ` (by ${deadline})` : '';
    lines.push(`• ${owner}: ${task}${dl}`);
  }
  return lines.join('\n');
}

/**
 * Render the topic thread (plain string, already compact).
 * @param {object} memory
 * @returns {string}
 */
export function serialiseTopicThread(memory) {
  if (!memory?.topicThread) return '';
  return `[Current Topic]\n${memory.topicThread}`;
}

// ── Compound builders for each LLM call type ─────────────────────────────

/**
 * Build the compressed context for SUGGESTION generation.
 * Budget: ~350-500 tokens.
 * Formula: current topic + recent decisions/questions/risks + 1 raw sentence tail.
 *
 * @param {object} memory  session.contextMemory
 * @param {string} recentRaw  last ~200 chars of raw transcript for grounding
 * @returns {string}
 */
export function buildCompressedSuggestionContext(memory, recentRaw) {
  const parts = [];

  const thread = serialiseTopicThread(memory);
  if (thread) parts.push(thread);

  // High-signal facts only: decisions, questions, risks, deadlines, numbers
  const highSignal = serialiseKeyFacts(memory, {
    maxFacts:  12,
    recencyMs: 5 * 60 * 1000, // last 5 minutes
    types: [
      FACT_TYPES.DECISION,
      FACT_TYPES.QUESTION,
      FACT_TYPES.RISK,
      FACT_TYPES.DEADLINE,
      FACT_TYPES.NUMBER,
    ],
  });
  if (highSignal) parts.push(highSignal);

  const actions = serialiseActionMap(memory, 5);
  if (actions) parts.push(actions);

  // Last ~300 chars of raw for recency grounding (so suggestions reference exact words)
  if (recentRaw) {
    const tail = recentRaw.trim().slice(-300).replace(/\s+/g, ' ');
    parts.push(`[Latest words]\n${tail}`);
  }

  return parts.join('\n\n');
}

/**
 * Build the compressed context for CHAT responses.
 * Budget: ~600-900 tokens.
 * Formula: full key facts + action map + topic thread + rolling summaries + last 2 raw chunks.
 *
 * @param {object} memory          session.contextMemory
 * @param {string[]} summaryBuffer rolling summaries from suggestionEngine
 * @param {object[]} recentChunks  last N raw chunks [{text}]
 * @param {number}   maxRawChars   cap on raw chunk characters
 * @returns {string}
 */
export function buildCompressedChatContext(memory, summaryBuffer, recentChunks, maxRawChars = 800) {
  const parts = [];

  // 1. Full key facts (all types, last 25, sorted by priority)
  const facts = serialiseKeyFacts(memory, { maxFacts: 25 });
  if (facts) parts.push(facts);

  // 2. Action map
  const actions = serialiseActionMap(memory, 10);
  if (actions) parts.push(actions);

  // 3. Rolling summaries (compressed history)
  if (summaryBuffer?.length) {
    parts.push('[Meeting History]\n' + summaryBuffer.join('\n'));
  }

  // 4. Topic thread (current topic spine)
  const thread = serialiseTopicThread(memory);
  if (thread) parts.push(thread);

  // 5. Last 2 raw chunks, capped at maxRawChars, for exact-quote grounding
  if (recentChunks?.length) {
    const rawText = recentChunks
      .slice(-2)
      .map(c => c.text)
      .join('\n\n')
      .slice(-maxRawChars);
    if (rawText.trim()) parts.push(`[Recent Transcript]\n${rawText.trim()}`);
  }

  return parts.join('\n\n') || '(no transcript yet)';
}

// ── Utilities ─────────────────────────────────────────────────────────────

function splitSentences(text) {
  return (String(text || '').match(/[^.!?\n]+[.!?]?/g) || [])
    .map(s => s.trim())
    .filter(Boolean);
}

const FILLER_RE = /^(?:um+|uh+|ah+|yeah|yep|okay|ok|right|so|well|like|you know|i mean|basically|actually|literally|honestly|you see|kind of|sort of|just|anyway)\b/i;

function isFiller(sentence) {
  const words = sentence.trim().split(/\s+/);
  return words.length < 8 && FILLER_RE.test(sentence.trim());
}

function normaliseKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function cleanFact(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/["""'']/g, '"')
    .trim()
    .replace(/[.,;:]+$/, '')
    .trim();
}