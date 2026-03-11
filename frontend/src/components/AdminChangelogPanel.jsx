import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import changelogMarkdown from '../../../CHANGELOG.md?raw';
import { parseChangelog } from '../utils/changelog.js';

function formatDateLabel(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function AdminChangelogPanel() {
  const [open, setOpen] = useState(false);
  const entries = useMemo(() => parseChangelog(changelogMarkdown), []);
  const latestEntry = entries[0];
  const latestDateLabel = useMemo(
    () => (latestEntry ? formatDateLabel(latestEntry.date) : 'No entries'),
    [latestEntry]
  );

  if (!latestEntry) return null;

  const modal = open ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Admin Changelog</p>
            <h2 className="mt-1 text-lg font-semibold text-white">Recent platform changes</h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
          >
            Close
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto px-5 py-5">
          {entries.map((entry) => (
            <section key={`${entry.date}-${entry.title}`} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="flex flex-col gap-2 border-b border-slate-800 pb-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                    {formatDateLabel(entry.date)}
                  </p>
                  <h3 className="mt-1 text-base font-semibold text-white">{entry.title}</h3>
                </div>
                <span className="rounded-full border border-slate-700 bg-slate-950 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-slate-400">
                  Release Note
                </span>
              </div>

              <p className="mt-3 text-sm text-slate-300">{entry.summary}</p>

              <div className="mt-4 space-y-4">
                {entry.sections.map((section) => (
                  <div key={`${entry.title}-${section.heading}`}>
                    <h4 className="text-sm font-medium text-slate-100">{section.heading}</h4>
                    <ul className="mt-2 space-y-2 text-sm text-slate-400">
                      {section.items.map((item) => (
                        <li key={item} className="flex gap-2">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400/70" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <div className="mb-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full rounded-lg border border-slate-800 bg-slate-900/85 px-3 py-2 text-left text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <svg className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-8.625a2.625 2.625 0 00-2.625-2.625H7.125A2.625 2.625 0 004.5 5.625v12.75A2.625 2.625 0 007.125 21h9.75a2.625 2.625 0 002.625-2.625V18M8.25 7.5h7.5M8.25 11.25h7.5M8.25 15h4.5" />
              </svg>
              <span>Changelog</span>
            </span>
            <svg className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {latestDateLabel}
          </div>
        </button>
      </div>
      {typeof document !== 'undefined' ? createPortal(modal, document.body) : null}
    </>
  );
}
