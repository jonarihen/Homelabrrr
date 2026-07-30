export function sanitizeError(msg) {
  if (!msg) return 'Internal server error';
  return msg
    .replace(/https?:\/\/[\d.:]+\/api2\/json\S*/g, '[proxmox-api]')
    .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g, '[internal-host]');
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Decode HTML entities in upstream error text.
 *
 * FortiOS HTML-escapes its CLI error strings, so a rejected `set server-cert`
 * comes back as `Return code -4 &#40;reached the maximum number of entries&#41;`.
 * Nothing downstream re-renders that as HTML — React escapes on output — so the
 * entities show up literally in the UI. Decode once, here, where upstream text
 * enters the app.
 *
 * `&amp;` is resolved last so `&amp;#40;` decodes to the literal `&#40;` rather
 * than being re-expanded into a bracket.
 */
export function decodeHtmlEntities(text) {
  if (!text) return text;
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => safeCodePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => safeCodePoint(parseInt(dec, 10), m))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(code, original) {
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return original;
  try { return String.fromCodePoint(code); } catch { return original; }
}
