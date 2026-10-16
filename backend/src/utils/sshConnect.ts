import { Client as SSHClient } from 'ssh2';
import { normalizeSshHostFingerprint, sshHostFingerprint } from './sshHostKey.ts';
import { sshClientError } from './sshError.ts';
import { log } from './logger.ts';

/**
 * Create an authenticated SSH connection with host key verification.
 *
 * @param {{host:string, port:number, username:string, privateKey:string, passphrase?:string, hostFingerprint:string}} opts
 * @param {AbortSignal} [signal] ends the client if aborted before it is ready
 * @returns {Promise<import('ssh2').Client>}
 */
export function createSshConnection({ host, port, username, privateKey, passphrase, hostFingerprint }, signal?: AbortSignal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('SSH connection aborted'));
      return;
    }
    const conn = new SSHClient();
    // Abort ends the in-progress handshake instead of waiting for ready/timeout.
    signal?.addEventListener('abort', () => {
      conn.end();
      reject(new Error('SSH connection aborted'));
    }, { once: true });
    const expectedFingerprint = normalizeSshHostFingerprint(hostFingerprint);
    let hostVerificationError = '';

    conn.on('ready', () => resolve(conn));

    conn.on('error', (err) => {
      reject(new Error(hostVerificationError || err.message));
    });

    try {
      conn.connect({
        host,
        port,
        username,
        privateKey,
        passphrase: passphrase || undefined,
        readyTimeout: 10000,
        hostVerifier: (key) => {
          const presented = sshHostFingerprint(key);
          if (presented !== expectedFingerprint) {
            hostVerificationError = `SSH host key mismatch. Expected ${expectedFingerprint}, got ${presented}`;
            return false;
          }
          return true;
        },
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Bridge a browser WebSocket (the `/api/ssh` console) to an interactive shell
 * on the target. The client's close handler is registered before the
 * handshake, so a tab closed mid-connect still ends the SSH session.
 */
export async function proxySshShell(clientWs, sshSession) {
  const { requestId, node, vmid, port } = sshSession;
  let conn = null;
  let clientGone = false;
  const handshake = new AbortController();
  clientWs.on('close', () => {
    clientGone = true;
    handshake.abort();
    conn?.end();
  });

  try {
    conn = await createSshConnection(sshSession, handshake.signal);
  } catch (err) {
    if (clientGone) return;
    const clientError = sshClientError(err);
    log('error', 'ssh_connection_failed', { requestId, node, vmid, code: clientError.code, errorName: err?.name || 'Error' });
    if (clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({ type: 'error', ...clientError }));
      clientWs.close();
    }
    return;
  }

  if (clientGone) {
    conn.end();
    return;
  }

  log('info', 'ssh_connected', { requestId, node, vmid, port });
  clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));

  conn.on('close', () => {
    if (clientWs.readyState === 1) clientWs.close();
  });

  const failShell = (err) => {
    if (clientWs.readyState === 1) {
      clientWs.send(JSON.stringify({ type: 'error', ...sshClientError(err) }));
      clientWs.close();
    }
    conn.end();
  };

  // ssh2 throws "Not connected" synchronously if the transport dropped right after ready.
  try {
    conn.shell({ term: 'xterm-256color' }, (err, stream) => {
      if (err) {
        failShell(err);
        return;
      }

      const forward = (data) => {
        if (clientWs.readyState === 1) {
          clientWs.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
        }
      };
      stream.on('data', forward);
      stream.stderr.on('data', forward);

      stream.on('close', () => {
        if (clientWs.readyState === 1) {
          clientWs.send(JSON.stringify({ type: 'status', status: 'disconnected' }));
          clientWs.close();
        }
      });

      clientWs.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'data') {
            stream.write(Buffer.from(msg.data, 'base64'));
          } else if (msg.type === 'resize' && msg.cols && msg.rows) {
            stream.setWindow(msg.rows, msg.cols, 0, 0);
          }
        } catch { /* ignore bad messages */ }
      });

      clientWs.on('close', () => stream.close());
    });
  } catch (err) {
    failShell(err);
  }
}
