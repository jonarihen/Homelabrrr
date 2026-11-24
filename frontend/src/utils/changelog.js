const ENTRY_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s+[—-]\s+(.+)$/;
const SECTION_RE = /^###\s+(.+)$/;
const DASH_BULLET_RE = /^-\s+(.+)$/;
const NUMBERED_BULLET_RE = /^\d+\.\s+(.+)$/;
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

function createParser() {
  return { entries: [], entry: null, section: null };
}

// An entry's summary is its first bullet, falling back to the title when the
// entry has no bullets at all.
function closeEntry(state) {
  if (!state.entry) return;
  state.entry.summary = state.entry.sections[0]?.items?.[0] || state.entry.title;
  state.entries.push(state.entry);
}

function startEntry(state, [, date, title]) {
  closeEntry(state);
  state.entry = { date, title, summary: '', sections: [], images: [] };
  state.section = null;
}

function startSection(state, heading) {
  state.section = { heading, items: [] };
  state.entry.sections.push(state.section);
}

function addBullet(state, text) {
  // Bullets before any `###` heading collect under an implicit section.
  if (!state.section) startSection(state, 'Notes');
  state.section.items.push(text);
}

// Ordered line handlers: the first one that claims the line wins. Each returns
// true when it consumed the line. Handlers after the first run only once an
// entry is open, so stray prose above the first `##` is ignored.
const HANDLERS = [
  (state, line) => {
    const match = line.match(ENTRY_RE);
    if (match) startEntry(state, match);
    return Boolean(match);
  },
  (state, line) => {
    const match = line.match(SECTION_RE);
    if (match) startSection(state, match[1]);
    return Boolean(match);
  },
  (state, line) => {
    const match = line.match(DASH_BULLET_RE) || line.match(NUMBERED_BULLET_RE);
    if (match) addBullet(state, match[1]);
    return Boolean(match);
  },
  (state, line) => {
    const match = line.match(IMAGE_RE);
    if (match) state.entry.images.push({ alt: match[1], src: match[2] });
    return Boolean(match);
  },
];

function isSkippable(line) {
  return !line || line === '---';
}

export function parseChangelog(markdown) {
  const state = createParser();

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (isSkippable(line)) continue;
    const handlers = state.entry ? HANDLERS : HANDLERS.slice(0, 1);
    handlers.some(handle => handle(state, line));
  }

  closeEntry(state);
  return state.entries;
}

// Inline markdown used in the changelog: `code`, **bold** and *emphasis*.
// Returns a token tree ({ type, text } or { type, children }) so the panel can
// render real elements; nothing is ever injected as HTML. Code is matched
// first, so asterisks inside backticks stay literal.
const INLINE_RE = /`([^`]+)`|\*\*(?=\S)(.+?)(?<=\S)\*\*|\*(?=[^\s*])([^*]+?)(?<=\S)\*/g;

export function inlineTokens(text) {
  const tokens = [];
  let last = 0;
  for (const match of String(text).matchAll(INLINE_RE)) {
    if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) });
    if (match[1] !== undefined) tokens.push({ type: 'code', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: 'bold', children: inlineTokens(match[2]) });
    else tokens.push({ type: 'em', children: inlineTokens(match[3]) });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) });
  return tokens;
}
