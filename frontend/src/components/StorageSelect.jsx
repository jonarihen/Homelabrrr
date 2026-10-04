export default function StorageSelect({
  label = 'Storage',
  labelCls = 'block text-xs text-gray-400 mb-1.5 font-medium',
  value = '',
  onChange,
  storages = [],
  inputCls = 'w-full bg-gray-800 border border-gray-700/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all',
  placeholder = 'local-lvm',
  filterContent = 'images',
}) {
  const options = filterContent ? storages.filter(s => s.content?.includes(filterContent)) : storages;

  return (
    <div>
      {label && <label className={labelCls}>{label}</label>}
      {storages.length > 0 ? (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className={inputCls}
        >
          {!storages.find(s => s.storage === value) && value && (
            <option value={value}>{value}</option>
          )}
          {options.map(s => (
            <option key={s.storage} value={s.storage}>{s.storage} ({s.type})</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          className={inputCls}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}
