import { useState, useEffect, useCallback } from 'react';
import api from '../api.js';

export default function useSSHConfig(node, vmid) {
  const [sshCfg, setSshCfg] = useState({ host: '', port: 22, username: 'root', hostFingerprint: '' });
  const [sshSaved, setSshSaved] = useState(false);
  const [sshSavingError, setSshSavingError] = useState('');
  const [scanningFingerprint, setScanningFingerprint] = useState(false);

  useEffect(() => {
    api.get(`/ssh/config/${node}/${vmid}`)
      .then(r => {
        if (r.data) {
          setSshCfg({
            host: r.data.host,
            port: r.data.port,
            username: r.data.username,
            hostFingerprint: r.data.hostFingerprint || '',
          });
        }
      })
      .catch(() => {});
  }, [node, vmid]);

  const saveSshConfig = useCallback(async () => {
    setSshSaved(false);
    setSshSavingError('');
    try {
      await api.put(`/ssh/config/${node}/${vmid}`, sshCfg);
      setSshSaved(true);
      setTimeout(() => setSshSaved(false), 2000);
    } catch (e) {
      setSshSavingError(e.response?.data?.error || 'Failed to save SSH config');
    }
  }, [node, vmid, sshCfg]);

  const scanSshFingerprint = useCallback(async () => {
    if (!sshCfg.host) {
      setSshSavingError('Enter the SSH host/IP before scanning');
      return;
    }

    setScanningFingerprint(true);
    setSshSavingError('');
    try {
      const { data } = await api.post(`/ssh/config/${node}/${vmid}/scan-fingerprint`, {
        host: sshCfg.host,
        port: sshCfg.port,
      });
      setSshCfg(c => ({ ...c, hostFingerprint: data.hostFingerprint || '' }));
    } catch (e) {
      setSshSavingError(e.response?.data?.error || 'Failed to scan SSH fingerprint');
    } finally {
      setScanningFingerprint(false);
    }
  }, [node, vmid, sshCfg.host, sshCfg.port]);

  return { sshCfg, setSshCfg, sshSaved, sshSavingError, scanningFingerprint, saveSshConfig, scanSshFingerprint };
}
