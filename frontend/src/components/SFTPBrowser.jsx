import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api.js';

function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function joinPath(...parts) {
  const joined = parts.join('/').replace(/\/+/g, '/');
  return joined || '/';
}

function parentDir(path) {
  if (path === '/') return '/';
  const parts = path.replace(/\/$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

export default function SFTPBrowser({ token }) {
  const [currentPath, setCurrentPath] = useState('.');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [showMkdir, setShowMkdir] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const fileInputRef = useRef(null);
  const dropRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const loadDir = useCallback(async (path) => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/sftp/ls', { token, path });
      setEntries(data.entries);
      setCurrentPath(data.path || path);
      setInitialLoaded(true);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to list directory');
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Load initial directory on mount
  useEffect(() => {
    loadDir(currentPath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = (name) => {
    loadDir(joinPath(currentPath, name));
  };

  const goUp = () => {
    const parent = parentDir(currentPath);
    if (parent !== currentPath) loadDir(parent);
  };

  const [downloading, setDownloading] = useState(null);

  const downloadFile = async (name) => {
    const filePath = joinPath(currentPath, name);
    setDownloading(name);
    try {
      const res = await api.get('/sftp/download', {
        params: { token, path: filePath },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.response?.data?.error || 'Download failed');
    } finally {
      setDownloading(null);
    }
  };

  const uploadFiles = async (files) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError('');
    try {
      for (const file of files) {
        const form = new FormData();
        form.append('token', token);
        form.append('path', currentPath);
        form.append('file', file);
        await api.post('/sftp/upload', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }
      await loadDir(currentPath);
    } catch (e) {
      setError(e.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const createDir = async () => {
    if (!mkdirName.trim()) return;
    setError('');
    try {
      await api.post('/sftp/mkdir', { token, path: joinPath(currentPath, mkdirName.trim()) });
      setMkdirName('');
      setShowMkdir(false);
      await loadDir(currentPath);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create directory');
    }
  };

  const deleteEntry = async (name, isDirectory) => {
    setError('');
    try {
      await api.post('/sftp/delete', {
        token,
        path: joinPath(currentPath, name),
        isDirectory,
      });
      setDeleteConfirm(null);
      await loadDir(currentPath);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete');
    }
  };

  const onDragOver = (e) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  };

  const breadcrumbs = currentPath === '/' ? ['/'] : currentPath.split('/').filter(Boolean);

  return (
    <div
      ref={dropRef}
      className={`flex h-full min-h-0 flex-col ${dragOver ? 'ring-2 ring-blue-500/50 ring-inset' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 bg-gray-900 shrink-0 flex-wrap">
        {/* Breadcrumb */}
        <button
          type="button"
          onClick={() => loadDir('/')}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >/</button>
        {breadcrumbs.map((seg, i) => {
          if (seg === '/') return null;
          const path = '/' + breadcrumbs.slice(0, i + 1).join('/');
          return (
            <span key={path} className="flex items-center gap-1 text-xs">
              <span className="text-gray-600">/</span>
              <button
                type="button"
                onClick={() => loadDir(path)}
                className="text-blue-400 hover:text-blue-300 transition-colors"
              >{seg}</button>
            </span>
          );
        })}

        <div className="flex-1" />

        {/* Actions */}
        <button
          type="button"
          onClick={goUp}
          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
          title="Go up"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => loadDir(currentPath)}
          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
          title="Refresh"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => setShowMkdir(!showMkdir)}
          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
          title="New folder"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
        >
          {uploading ? 'Uploading...' : 'Upload'}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => uploadFiles(e.target.files)}
        />
      </div>

      {/* Mkdir inline */}
      {showMkdir && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 bg-gray-900/50">
          <input
            type="text"
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createDir()}
            placeholder="New folder name"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
            autoFocus
          />
          <button
            type="button"
            onClick={createDir}
            className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >Create</button>
          <button
            type="button"
            onClick={() => { setShowMkdir(false); setMkdirName(''); }}
            className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
          >Cancel</button>
        </div>
      )}

      {error && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-900/20 border-b border-gray-700">
          {error}
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && !initialLoaded ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">Loading...</div>
        ) : entries.length === 0 && !loading ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">Empty directory</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900 text-gray-500 text-xs">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-right px-4 py-2 font-medium w-24">Size</th>
                <th className="text-right px-4 py-2 font-medium w-40 hidden sm:table-cell">Modified</th>
                <th className="text-right px-4 py-2 font-medium w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {currentPath !== '/' && (
                <tr
                  className="border-t border-gray-800 hover:bg-gray-800/50 cursor-pointer transition-colors"
                  onClick={goUp}
                >
                  <td className="px-4 py-2 text-gray-300" colSpan="4">
                    <span className="inline-flex items-center gap-2">
                      <FolderIcon />
                      <span>..</span>
                    </span>
                  </td>
                </tr>
              )}
              {entries.map((entry) => (
                <tr
                  key={entry.name}
                  className="border-t border-gray-800 hover:bg-gray-800/50 transition-colors"
                >
                  <td className="px-4 py-2">
                    {entry.type === 'directory' ? (
                      <button
                        type="button"
                        onClick={() => navigate(entry.name)}
                        className="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <FolderIcon />
                        <span className="truncate max-w-xs">{entry.name}</span>
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-2 text-gray-300">
                        <FileIcon />
                        <span className="truncate max-w-xs">{entry.name}</span>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500 text-xs font-mono">
                    {entry.type !== 'directory' ? formatSize(entry.size) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500 text-xs hidden sm:table-cell">
                    {formatDate(entry.modifyTime)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {entry.type !== 'directory' && (
                        <button
                          type="button"
                          onClick={() => downloadFile(entry.name)}
                          disabled={downloading === entry.name}
                          className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-white disabled:opacity-50 transition-colors"
                          title="Download"
                        >
                          {downloading === entry.name ? (
                            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                          ) : (
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                            </svg>
                          )}
                        </button>
                      )}
                      {deleteConfirm === entry.name ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => deleteEntry(entry.name, entry.type === 'directory')}
                            className="rounded px-1.5 py-0.5 text-[10px] bg-red-600 hover:bg-red-500 text-white transition-colors"
                          >Yes</button>
                          <button
                            type="button"
                            onClick={() => setDeleteConfirm(null)}
                            className="rounded px-1.5 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
                          >No</button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDeleteConfirm(entry.name)}
                          className="rounded p-1 text-gray-500 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                          title="Delete"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {loading && initialLoaded && (
          <div className="flex items-center justify-center py-4 text-gray-500 text-xs">Loading...</div>
        )}
      </div>

      {/* Drop zone overlay */}
      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-500/50 rounded-lg z-10 pointer-events-none">
          <p className="text-blue-300 text-sm font-medium">Drop files to upload</p>
        </div>
      )}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg className="w-4 h-4 text-yellow-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M19.5 21a3 3 0 003-3v-4.5a3 3 0 00-3-3h-15a3 3 0 00-3 3V18a3 3 0 003 3h15zM1.5 10.146V6a3 3 0 013-3h5.379a2.25 2.25 0 011.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 013 3v1.146A4.483 4.483 0 0019.5 9h-15a4.483 4.483 0 00-3 1.146z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="w-4 h-4 text-gray-500 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}
