// Clipboard → VNC "paste" support.
//
// The VNC console has no clipboard channel into the guest: QEMU's VNC
// ClientCutText only reaches the guest clipboard when the VM runs
// spice-vdagent with the `clipboard=vnc` display option, which our guests
// generally don't. So "paste" here means replaying the clipboard as
// synthesized keystrokes — it works on any guest, in any state (login
// prompt, TTY, installer), with no agent.

const XK_Return = 0xff0d;
const XK_Tab = 0xff09;

// Same module noVNC's own keyboard handler uses; maps a unicode codepoint to
// the X11 keysym QEMU expects (Latin-1 is 1:1, others use lookup tables with
// a 0x01000000|codepoint fallback).
const keysymsPromise = import('@novnc/novnc/lib/input/keysymdef.js');

export async function readClipboardText() {
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Permission denied or unsupported (e.g. older Firefox) — fall through
      // to a manual prompt, which still lets the user Ctrl+V the text in.
    }
  }
  return window.prompt('Paste the text to send to the VM:') ?? '';
}

// Types `text` into the guest one key press/release at a time. The small
// per-character delay keeps slow guests (BIOS, GRUB, installers) from
// dropping keys. Returns the number of characters sent. `shouldStop` is
// polled between characters so callers can abort on unmount/disconnect;
// noVNC's sendKey is itself a no-op once the connection is gone.
export async function typeIntoVnc(rfb, text, { charDelayMs = 10, shouldStop = () => false } = {}) {
  const { default: keysyms } = await keysymsPromise;
  let sent = 0;

  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (!rfb || shouldStop()) break;

    let keysym;
    if (ch === '\n') keysym = XK_Return;
    else if (ch === '\t') keysym = XK_Tab;
    else {
      const cp = ch.codePointAt(0);
      if (cp < 0x20) continue; // other control characters have no key
      keysym = keysyms.lookup(cp);
    }

    rfb.sendKey(keysym, null); // press + release
    sent += 1;
    if (charDelayMs > 0) await new Promise((r) => setTimeout(r, charDelayMs));
  }

  return sent;
}
