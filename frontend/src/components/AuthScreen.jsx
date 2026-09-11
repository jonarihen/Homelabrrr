// The chrome shared by the unauthenticated screens (Login, AcceptInvite):
// centered plate, wordmark, numbered section header and status footer. Keep
// these pages in sync by changing this component, not by copying markup.

export const authLabelCls = 'block text-[10px] font-mono uppercase tracking-[0.14em] text-gray-500 mb-2';
export const authInputCls = 'w-full bg-[#0b0d11] border border-gray-700 px-3.5 py-3 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:border-orange-600 transition-colors';
export const authBtnCls = 'w-full border border-orange-600 bg-orange-600 text-[#0e1014] font-mono text-xs font-semibold uppercase tracking-[0.14em] py-3.5 hover:bg-orange-500 hover:border-orange-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors';

export default function AuthScreen({ step = '01', title, footerNote, children }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
      <div className="w-full max-w-sm relative">
        {/* Wordmark / identity plate */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 border border-orange-600 flex items-center justify-center text-orange-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <rect x="2" y="3" width="20" height="14" rx="0" />
                <path d="M8 21h8M12 17v4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="leading-none">
              <div className="aaris-display text-lg text-gray-100">VM Manager</div>
              <div className="aaris-meta mt-1 text-[10px]">Operator Console</div>
            </div>
          </div>
          <div className="h-px bg-gray-700" />
        </div>

        {/* Section header */}
        <div className="flex items-baseline gap-3 mb-4">
          <span className="font-mono text-xs font-semibold text-orange-600 tracking-[0.12em]">{step}</span>
          <h1 className="aaris-display text-sm text-gray-300">{title}</h1>
        </div>

        {children}

        {/* Status footer */}
        <div className="mt-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-gray-600">
          <span className="flex items-center gap-1.5"><span className="aaris-led aaris-led--ok" /> Session · TLS</span>
          <span>{footerNote}</span>
        </div>
      </div>
    </div>
  );
}
