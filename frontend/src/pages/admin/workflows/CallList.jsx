export default function CallList({ calls }) {
  if (!calls || calls.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {calls.map((c, i) => (
        <div key={i} className="border border-gray-800 bg-gray-950 px-2.5 py-1.5 font-mono text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-orange-500">{c.method}</span>
            <span className="text-gray-300">/api/v2/{c.path}</span>
            {c.scope && <span className="text-gray-600">· {c.scope}</span>}
          </div>
          {c.summary && <div className="mt-0.5 text-gray-500">{c.summary}</div>}
          {c.body && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-gray-400">{JSON.stringify(c.body)}</pre>}
        </div>
      ))}
    </div>
  );
}
