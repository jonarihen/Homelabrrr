import Modal from './Modal.jsx';
import VNCSessionPanel from './VNCSessionPanel.jsx';

export default function VNCModal({ vm, onClose }) {
  return (
    <Modal title={`VNC — ${vm.name || `VM ${vm.vmid}`}`} onClose={onClose} size="full">
      <div style={{ height: '75vh' }}>
        <VNCSessionPanel vm={vm} visible />
      </div>
    </Modal>
  );
}
