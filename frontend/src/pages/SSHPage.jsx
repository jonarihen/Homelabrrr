import { useParams, useNavigate } from 'react-router-dom';
import useDocumentTitle from '../hooks/useDocumentTitle.js';
import SSHSessionPanel from '../components/SSHSessionPanel.jsx';
import { displayNode } from '../utils/nodeRef.js';

export default function SSHPage() {
  const { node, vmid } = useParams();
  useDocumentTitle(`SSH - VM ${vmid}`);
  const navigate = useNavigate();

  const vm = { node, vmid: Number(vmid), nodeRef: node, name: `VM ${vmid}` };

  return (
    <div className="flex flex-col h-screen bg-gray-950">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="text-gray-400 hover:text-white transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>

        <span className="text-gray-400 text-sm">
          SSH &mdash; {displayNode(node)}/{vmid}
        </span>

        <div className="flex-1" />

        <button
          onClick={() => {
            const el = document.documentElement;
            if (!document.fullscreenElement) el.requestFullscreen();
            else document.exitFullscreen();
          }}
          className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
        >
          Fullscreen
        </button>
      </div>

      {/* SSH panel */}
      <div className="flex-1 min-h-0">
        <SSHSessionPanel vm={vm} visible />
      </div>
    </div>
  );
}
