const configs = {
  running: { dot: 'bg-green-400 animate-pulse', bg: 'bg-green-500/10 ring-green-500/20', text: 'text-green-400', label: 'Running' },
  stopped: { dot: 'bg-red-500',                 bg: 'bg-red-500/10 ring-red-500/20',     text: 'text-red-400',   label: 'Stopped' },
  paused:  { dot: 'bg-yellow-400',              bg: 'bg-yellow-500/10 ring-yellow-500/20',text: 'text-yellow-400',label: 'Paused' },
  error:   { dot: 'bg-red-600',                 bg: 'bg-red-500/10 ring-red-500/20',     text: 'text-red-500',   label: 'Error' },
};

export default function StatusBadge({ status }) {
  const c = configs[status] || { dot: 'bg-gray-500', bg: 'bg-gray-500/10 ring-gray-500/20', text: 'text-gray-400', label: status };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ring-1 ${c.bg} ${c.text}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
}
