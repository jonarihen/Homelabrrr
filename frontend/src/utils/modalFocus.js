const focusableSelector = 'a[href], area[href], button, input, select, textarea, iframe, audio[controls], video[controls], summary, [contenteditable]:not([contenteditable="false"]), [tabindex]';
const scrollLocks = new WeakMap();
const modalStates = new WeakMap();

function canFocus(element) {
  if (!element?.isConnected || typeof element.focus !== 'function') return false;
  if (element.matches(':disabled') || element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
  const { visibility } = element.ownerDocument.defaultView.getComputedStyle(element);
  return visibility !== 'hidden' && visibility !== 'collapse' && element.getClientRects().length > 0;
}

export function getFocusableElements(dialog) {
  const elements = Array.from(dialog.querySelectorAll(focusableSelector)).filter((element) => (
    element.tabIndex >= 0 && canFocus(element) && element.closest('[role="dialog"]') === dialog
  ));
  return elements.filter((element) => {
    if (!element.matches('input[type="radio"]') || !element.name) return true;
    const group = elements.filter((other) => other.matches('input[type="radio"]') && other.name === element.name && other.form === element.form);
    return element === (group.find((other) => other.checked) || group[0]);
  }).sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

export function getTabDestination(elements, activeElement, backwards, dialog) {
  if (!elements.length) return dialog;
  const index = elements.indexOf(activeElement);
  if (index === -1) return backwards ? elements.at(-1) : elements[0];
  if (backwards && index === 0) return elements.at(-1);
  if (!backwards && index === elements.length - 1) return elements[0];
  return null;
}

export function lockBackgroundScroll(doc, dialog) {
  const elements = new Set([doc.documentElement, doc.body]);
  for (let parent = dialog?.parentElement; parent; parent = parent.parentElement) {
    const { overflowX, overflowY } = doc.defaultView.getComputedStyle(parent);
    if (scrollLocks.has(parent) || [overflowX, overflowY].some((value) => /^(auto|scroll|overlay)$/.test(value))) elements.add(parent);
  }
  const locks = Array.from(elements, (element) => {
    let lock = scrollLocks.get(element);
    if (!lock) {
      const properties = ['overflow-x', 'overflow-y'].map((name) => ({
        name,
        value: element.style.getPropertyValue(name),
        priority: element.style.getPropertyPriority(name),
      }));
      lock = { count: 0, properties };
      scrollLocks.set(element, lock);
      for (const { name } of properties) element.style.setProperty(name, 'hidden', 'important');
    }
    lock.count += 1;
    return { element, lock };
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const { element, lock } of locks) {
      lock.count -= 1;
      if (lock.count) continue;
      for (const { name, value, priority } of lock.properties) {
        if (element.style.getPropertyValue(name) !== 'hidden' || element.style.getPropertyPriority(name) !== 'important') continue;
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      }
      scrollLocks.delete(element);
    }
  };
}

function focusInitial(entry) {
  const { dialog, content } = entry;
  const activeElement = dialog.ownerDocument.activeElement;
  if (dialog.contains(activeElement) && activeElement.closest('[role="dialog"]') === dialog && canFocus(activeElement)) return;
  const elements = getFocusableElements(dialog);
  const target = elements.find((element) => element.hasAttribute('autofocus'))
    || elements.find((element) => content.contains(element))
    || dialog;
  target.focus({ preventScroll: true });
}

function restoreWithin(entry, target) {
  if (entry.dialog.contains(target) && canFocus(target)) target.focus({ preventScroll: true });
  else if (entry.dialog.contains(entry.lastFocused) && canFocus(entry.lastFocused)) entry.lastFocused.focus({ preventScroll: true });
  else focusInitial(entry);
}

export function isTopModal(dialog) {
  return modalStates.get(dialog?.ownerDocument)?.entries.at(-1)?.dialog === dialog;
}

export function activateModal({ dialog, content, trigger, onClose }) {
  const doc = dialog.ownerDocument;
  let state = modalStates.get(doc);
  if (!state) {
    state = { entries: [] };
    state.keydown = (event) => {
      const entry = state.entries.at(-1);
      if (!entry) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        entry.onClose();
      } else if (event.key === 'Tab') {
        const target = getTabDestination(getFocusableElements(entry.dialog), doc.activeElement, event.shiftKey, entry.dialog);
        if (target) {
          event.preventDefault();
          target.focus({ preventScroll: true });
        }
      }
    };
    state.focusin = (event) => {
      const entry = state.entries.at(-1);
      if (!entry) return;
      if (entry.dialog.contains(event.target)) entry.lastFocused = event.target;
      else restoreWithin(entry, entry.lastFocused);
    };
    modalStates.set(doc, state);
    doc.addEventListener('keydown', state.keydown, true);
    doc.addEventListener('focusin', state.focusin, true);
  }
  const entry = { dialog, content, trigger, onClose, lastFocused: null };
  const childIndex = state.entries.findIndex((other) => dialog.contains(other.dialog));
  state.entries.splice(childIndex === -1 ? state.entries.length : childIndex, 0, entry);
  const unlock = lockBackgroundScroll(doc, dialog);
  if (isTopModal(dialog)) focusInitial(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const wasTop = isTopModal(dialog);
    state.entries.splice(state.entries.indexOf(entry), 1);
    for (const other of state.entries) {
      if (dialog.contains(other.trigger)) other.trigger = entry.trigger;
    }
    unlock();
    const top = state.entries.at(-1);
    if (top) {
      if (wasTop) restoreWithin(top, entry.trigger);
    } else {
      doc.removeEventListener('keydown', state.keydown, true);
      doc.removeEventListener('focusin', state.focusin, true);
      modalStates.delete(doc);
      if (canFocus(entry.trigger)) entry.trigger.focus({ preventScroll: true });
    }
  };
}
