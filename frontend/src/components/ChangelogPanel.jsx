import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import changelogMarkdown from '../../../CHANGELOG.md?raw';
import { inlineTokens, parseChangelog } from '../utils/changelog.js';
import Modal from './Modal.jsx';

// Renders the inline markdown of one changelog line as elements.
function renderTokens(tokens) {
  return tokens.map((token, index) => {
    if (token.type === 'bold') return <strong key={index} className="font-semibold text-gray-100">{renderTokens(token.children)}</strong>;
    if (token.type === 'em') return <em key={index}>{renderTokens(token.children)}</em>;
    if (token.type === 'code') return <code key={index} className="bg-gray-800 px-1 py-0.5 font-mono text-[0.85em] text-gray-200 break-words">{token.text}</code>;
    return token.text;
  });
}
const Inline = ({ text }) => renderTokens(inlineTokens(text));

// Screenshots referenced from CHANGELOG.md as docs/screenshots/changelog/<file>; Vite bundles them.
const screenshotUrls = import.meta.glob('../../../docs/screenshots/changelog/*.{png,jpg,jpeg,webp,gif}', {
  eager: true,
  query: '?url',
  import: 'default',
});
function resolveScreenshot(src) {
  const file = src.split('/').pop();
  return Object.entries(screenshotUrls).find(([p]) => p.endsWith(`/${file}`))?.[1] || null;
}

function formatDateLabel(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function ChangelogPanel() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const triggerRef = useRef(null);
  const entries = useMemo(() => parseChangelog(changelogMarkdown), []);
  const latestEntry = entries[0];
  const latestDateLabel = useMemo(
    () => (latestEntry ? formatDateLabel(latestEntry.date) : 'No entries'),
    [latestEntry]
  );

  if (!latestEntry) return null;

  const modal = open ? (
    <Modal title="Recent platform changes" onClose={() => setOpen(false)} size="xl">
        <div className="space-y-5 px-5 py-5">
          {entries.map((entry) => (
            <section key={`${entry.date}-${entry.title}`} className="border border-gray-800 bg-gray-900/70 p-4">
              <div className="flex flex-col gap-2 border-b border-gray-800 pb-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-gray-500">
                    {formatDateLabel(entry.date)}
                  </p>
                  <h3 className="mt-1 text-base font-semibold text-white">{entry.title}</h3>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {entry.images.some((img) => resolveScreenshot(img.src)) && (
                    <button
                      type="button"
                      onClick={() => setPreview(entry)}
                      className="inline-flex items-center gap-1.5 border border-orange-700/60 bg-orange-950/40 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-orange-300 transition-colors hover:bg-orange-900/50 hover:text-orange-100"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0021.75 19.5V4.5A1.5 1.5 0 0020.25 3H3.75A1.5 1.5 0 002.25 4.5v15A1.5 1.5 0 003.75 21zM16.5 8.25h.008v.008H16.5V8.25z" />
                      </svg>
                      Example
                    </button>
                  )}
                  <span className="border border-gray-700 bg-gray-950 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-gray-400">
                    Release Note
                  </span>
                </div>
              </div>

              <p className="mt-3 text-sm text-gray-300"><Inline text={entry.summary} /></p>

              <div className="mt-4 space-y-4">
                {entry.sections.map((section) => (
                  <div key={`${entry.title}-${section.heading}`}>
                    <h4 className="text-sm font-medium text-gray-100">{section.heading}</h4>
                    <ul className="mt-2 space-y-2 text-sm text-gray-400">
                      {section.items.map((item) => (
                        <li key={item} className="flex gap-2">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-orange-600" />
                          <span className="min-w-0"><Inline text={item} /></span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      {preview && (
        <Modal title={`Example — ${preview.title}`} onClose={() => setPreview(null)} size="xl">
          <div className="space-y-4 p-4">
            {preview.images.map((img) => {
              const url = resolveScreenshot(img.src);
              return url ? (
                <figure key={img.src}>
                  <img src={url} alt={img.alt} className="w-full border border-gray-800" />
                  {img.alt && <figcaption className="mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-gray-500">{img.alt}</figcaption>}
                </figure>
              ) : null;
            })}
          </div>
        </Modal>
      )}
    </Modal>
  ) : null;

  return (
    <>
      <div className="mb-3">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          className="w-full border border-gray-800 bg-gray-900/85 px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em]">
              <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-8.625a2.625 2.625 0 00-2.625-2.625H7.125A2.625 2.625 0 004.5 5.625v12.75A2.625 2.625 0 007.125 21h9.75a2.625 2.625 0 002.625-2.625V18M8.25 7.5h7.5M8.25 11.25h7.5M8.25 15h4.5" />
              </svg>
              <span>Changelog</span>
            </span>
            <svg className="h-4 w-4 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
          <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.1em] text-gray-500">
            {latestDateLabel}
          </div>
        </button>
      </div>
      {typeof document !== 'undefined' ? createPortal(modal, document.body) : null}
    </>
  );
}
