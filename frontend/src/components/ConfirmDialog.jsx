import Modal from './Modal.jsx';

// Rendered by FeedbackProvider; call sites use useConfirm() instead.
// Enter submits (confirms) unless focus is on Cancel, which is where a danger
// dialog starts so a stray Enter or Space takes the safe choice.
export default function ConfirmDialog({ title, message, confirmLabel, cancelLabel, danger, onConfirm, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel} size="sm">
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(); }} className="p-5 space-y-5">
        {message && <p className="text-sm text-gray-300 whitespace-pre-line break-words">{message}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            autoFocus={danger}
            className="px-4 py-2 text-sm border border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            autoFocus={!danger}
            className={`px-4 py-2 text-sm font-semibold text-white transition-colors ${danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
