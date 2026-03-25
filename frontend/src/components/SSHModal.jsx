import Modal from './Modal.jsx';
import SSHSessionPanel from './SSHSessionPanel.jsx';

export default function SSHModal({ vm, onClose }) {
  return (
    <Modal
      title={`SSH — ${vm.name || `VM ${vm.vmid}`}`}
      onClose={onClose}
      size="full"
    >
      <div style={{ height: '75vh' }}>
        <SSHSessionPanel vm={vm} visible />
      </div>
    </Modal>
  );
}
