import test from 'node:test';
import assert from 'node:assert/strict';
import { activateModal, getFocusableElements, getTabDestination, isTopModal, lockBackgroundScroll, refreshModalFocus } from './modalFocus.js';

function style(initial = {}) {
  const properties = new Map(Object.entries(initial).map(([name, value]) => [name, [value, '']]));
  return {
    getPropertyValue: (name) => properties.get(name)?.[0] || '',
    getPropertyPriority: (name) => properties.get(name)?.[1] || '',
    setProperty: (name, value, priority = '') => properties.set(name, [value, priority]),
    removeProperty: (name) => properties.delete(name),
  };
}

function documentFixture() {
  const listeners = new Map();
  const doc = {
    body: { style: style() },
    documentElement: { style: style() },
    defaultView: { getComputedStyle: (element) => ({
      visibility: element.visibility || 'visible',
      overflowX: element.style?.getPropertyValue('overflow-x') || element.overflowX || 'visible',
      overflowY: element.style?.getPropertyValue('overflow-y') || element.overflowY || 'visible',
    }) },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      assert.equal(listeners.get(type), listener);
      listeners.delete(type);
    },
    dispatch(type, values = {}) {
      const event = { prevented: false, stopped: false, ...values };
      event.preventDefault = () => { event.prevented = true; };
      event.stopPropagation = () => { event.stopped = true; };
      listeners.get(type)?.(event);
      return event;
    },
    listeners,
  };
  const trigger = element(doc);
  doc.activeElement = trigger;
  return { doc, trigger };
}

function element(doc, options = {}) {
  const node = {
    ownerDocument: doc,
    isConnected: true,
    tabIndex: 0,
    children: [],
    ...options,
    contains(target) { return target === this || this.children.some((child) => child.contains(target)); },
    closest(selector) {
      if (selector === '[role="dialog"]') return this.dialog;
      return this.blocked ? this : null;
    },
    matches(selector) {
      if (selector === ':disabled') return !!this.disabled;
      return selector === 'input[type="radio"]' && !!this.radio;
    },
    hasAttribute: (name) => name === 'autofocus' && !!options.autofocus,
    getClientRects() { return this.hidden ? [] : [{}]; },
    querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll()]); },
    focus(focusOptions) {
      this.focusOptions = focusOptions;
      doc.activeElement = this;
      doc.dispatch('focusin', { target: this });
    },
  };
  return node;
}

function modal(doc, options = {}) {
  const dialog = element(doc, { tabIndex: -1 });
  const close = element(doc, { dialog });
  const controls = (options.controls ?? [{}]).map((control) => element(doc, { dialog, ...control }));
  const content = element(doc, { tabIndex: -1, children: controls, dialog });
  dialog.dialog = dialog;
  dialog.children = [close, content];
  return { dialog, content, close, controls };
}

function open(modal, trigger, onClose = () => {}) {
  return activateModal({ ...modal, trigger, onClose });
}

test('Tab wraps at both edges and recovers from an unfocusable active element', () => {
  const first = {}, middle = {}, last = {}, dialog = {};
  const controls = [first, middle, last];
  assert.equal(getTabDestination(controls, last, false, dialog), first);
  assert.equal(getTabDestination(controls, first, true, dialog), last);
  assert.equal(getTabDestination(controls, middle, false, dialog), null);
  assert.equal(getTabDestination(controls, middle, true, dialog), null);
  assert.equal(getTabDestination(controls, dialog, false, dialog), first);
  assert.equal(getTabDestination(controls, {}, true, dialog), last);
  assert.equal(getTabDestination([], first, false, dialog), dialog);
  assert.equal(getTabDestination([], first, true, dialog), dialog);
});

test('focusable controls exclude disabled, hidden, inert, disconnected and negative-tabindex elements', () => {
  const { doc } = documentFixture();
  const entry = modal(doc, { controls: [
    {}, { disabled: true }, { hidden: true }, { blocked: true }, { visibility: 'hidden' },
    { visibility: 'collapse' }, { isConnected: false }, { tabIndex: -1 },
  ] });
  assert.deepEqual(getFocusableElements(entry.dialog), [entry.close, entry.controls[0]]);
});

test('tab order accounts for positive tabindex, radio groups and nested dialogs', () => {
  const { doc } = documentFixture();
  const entry = modal(doc, { controls: [
    { tabIndex: 2 }, { tabIndex: 1 }, { radio: true, name: 'choice' },
    { radio: true, name: 'choice', checked: true }, { radio: true, name: 'other' },
  ] });
  const nested = modal(doc);
  entry.content.children.push(nested.dialog);
  assert.deepEqual(getFocusableElements(entry.dialog), [entry.controls[1], entry.controls[0], entry.close, entry.controls[3], entry.controls[4]]);
});

test('opening focuses the first content control and closing restores the trigger', () => {
  const { doc, trigger } = documentFixture();
  const entry = modal(doc);
  const release = open(entry, trigger);
  assert.equal(doc.activeElement, entry.controls[0]);
  assert.deepEqual(entry.controls[0].focusOptions, { preventScroll: true });
  release();
  assert.equal(doc.activeElement, trigger);
  assert.equal(doc.listeners.size, 0);
  release();
});

test('initial focus prefers autofocus and preserves an already focused content control', () => {
  const { doc, trigger } = documentFixture();
  const entry = modal(doc, { controls: [{}, { autofocus: true }] });
  let release = open(entry, trigger);
  assert.equal(doc.activeElement, entry.controls[1]);
  release();
  doc.activeElement = entry.controls[0];
  release = open(entry, trigger);
  assert.equal(doc.activeElement, entry.controls[0]);
  release();
});

test('replacing active content refocuses the reused modal without changing its return trigger or scroll lock', () => {
  const { doc, trigger } = documentFixture();
  const entry = modal(doc);
  const release = open(entry, trigger);
  const original = entry.controls[0];
  const replacement = element(doc, { dialog: entry.dialog });
  entry.content.children = [replacement];
  original.isConnected = false;
  doc.activeElement = doc.body;
  refreshModalFocus(entry.dialog);
  assert.equal(doc.activeElement, replacement);
  assert.equal(doc.body.style.getPropertyValue('overflow-y'), 'hidden');
  const back = element(doc, { dialog: entry.dialog });
  entry.content.children = [back];
  replacement.isConnected = false;
  doc.activeElement = doc.body;
  refreshModalFocus(entry.dialog);
  assert.equal(doc.activeElement, back);
  release();
  assert.equal(doc.activeElement, trigger);
  assert.equal(doc.body.style.getPropertyValue('overflow-y'), '');
});

test('focus refresh preserves valid control and dialog focus and repairs disabled or missing controls', () => {
  const { doc, trigger } = documentFixture();
  const entry = modal(doc, { controls: [{ autofocus: true }, {}] });
  const release = open(entry, trigger);
  entry.controls[1].focus();
  const focusOptions = entry.controls[1].focusOptions;
  refreshModalFocus(entry.dialog);
  assert.equal(doc.activeElement, entry.controls[1]);
  assert.equal(entry.controls[1].focusOptions, focusOptions);
  entry.controls[1].disabled = true;
  refreshModalFocus(entry.dialog);
  assert.equal(doc.activeElement, entry.controls[0]);
  entry.content.children = [];
  doc.activeElement = doc.body;
  refreshModalFocus(entry.dialog);
  assert.equal(doc.activeElement, entry.dialog);
  const dialogFocusOptions = entry.dialog.focusOptions;
  refreshModalFocus(entry.dialog);
  assert.equal(entry.dialog.focusOptions, dialogFocusOptions);
  release();
  doc.activeElement = doc.body;
  refreshModalFocus(entry.dialog);
  refreshModalFocus(null);
  refreshModalFocus(undefined);
  assert.equal(doc.activeElement, doc.body);
});

test('refreshing a covered parent cannot steal focus from a nested modal', () => {
  const { doc, trigger } = documentFixture();
  const parent = modal(doc);
  const child = modal(doc, { controls: [{}, {}] });
  parent.content.children.push(child.dialog);
  const releaseParent = open(parent, trigger);
  const releaseChild = open(child, parent.controls[0]);
  child.controls[1].focus();
  refreshModalFocus(parent.dialog);
  refreshModalFocus(child.dialog);
  assert.equal(doc.activeElement, child.controls[1]);
  doc.activeElement = doc.body;
  refreshModalFocus(parent.dialog);
  assert.equal(doc.activeElement, doc.body);
  refreshModalFocus(child.dialog);
  assert.equal(doc.activeElement, child.controls[0]);
  releaseChild();
  releaseParent();
  assert.equal(doc.activeElement, trigger);
});

test('a dialog with no meaningful control focuses itself and includes Close in the Tab loop', () => {
  const { doc, trigger } = documentFixture();
  const entry = modal(doc, { controls: [{ disabled: true }] });
  const release = open(entry, trigger);
  assert.equal(doc.activeElement, entry.dialog);
  assert.equal(doc.dispatch('keydown', { key: 'Tab' }).prevented, true);
  assert.equal(doc.activeElement, entry.close);
  entry.close.disabled = true;
  assert.equal(doc.dispatch('keydown', { key: 'Tab', shiftKey: true }).prevented, true);
  assert.equal(doc.activeElement, entry.dialog);
  release();
});

test('focus cannot escape and Tab destinations are recalculated after controls change', () => {
  const { doc, trigger } = documentFixture();
  const entry = modal(doc, { controls: [{}, {}] });
  const release = open(entry, trigger);
  trigger.focus();
  assert.equal(doc.activeElement, entry.controls[0]);
  entry.controls[1].focus();
  assert.equal(doc.dispatch('keydown', { key: 'Tab' }).prevented, true);
  assert.equal(doc.activeElement, entry.close);
  entry.controls[1].disabled = true;
  assert.equal(doc.dispatch('keydown', { key: 'Tab', shiftKey: true }).prevented, true);
  assert.equal(doc.activeElement, entry.controls[0]);
  release();
});

test('only the top modal handles Escape and focus restores through nested triggers', () => {
  const { doc, trigger } = documentFixture();
  const parent = modal(doc);
  const child = modal(doc);
  parent.content.children.push(child.dialog);
  let parentCloses = 0, childCloses = 0;
  const releaseParent = open(parent, trigger, () => { parentCloses += 1; });
  const releaseChild = open(child, parent.controls[0], () => { childCloses += 1; });
  assert.equal(isTopModal(parent.dialog), false);
  assert.equal(isTopModal(child.dialog), true);
  const event = doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(childCloses, 1);
  assert.equal(parentCloses, 0);
  releaseChild();
  assert.equal(doc.activeElement, parent.controls[0]);
  assert.equal(doc.body.style.getPropertyValue('overflow-y'), 'hidden');
  doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(parentCloses, 1);
  releaseParent();
  assert.equal(doc.activeElement, trigger);
});

test('child-first activation keeps the child on top when its parent mounts', () => {
  const { doc, trigger } = documentFixture();
  const parent = modal(doc);
  const child = modal(doc);
  parent.content.children.push(child.dialog);
  const releaseChild = open(child, parent.controls[0]);
  const releaseParent = open(parent, trigger);
  assert.equal(isTopModal(child.dialog), true);
  assert.equal(doc.activeElement, child.controls[0]);
  releaseChild();
  assert.equal(doc.activeElement, parent.controls[0]);
  releaseParent();
  assert.equal(doc.activeElement, trigger);
});

test('out-of-order removal does not steal focus and retains a surviving modal return target', () => {
  const { doc, trigger } = documentFixture();
  const first = modal(doc);
  const second = modal(doc);
  const third = modal(doc);
  const releaseFirst = open(first, trigger);
  const releaseSecond = open(second, first.controls[0]);
  const releaseThird = open(third, second.controls[0]);
  releaseFirst();
  releaseSecond();
  assert.equal(doc.activeElement, third.controls[0]);
  assert.equal(doc.body.style.getPropertyValue('overflow-y'), 'hidden');
  releaseThird();
  assert.equal(doc.activeElement, trigger);
  assert.equal(doc.listeners.size, 0);
});

test('closing uses a safe fallback if the trigger is removed or disabled', () => {
  const { doc, trigger } = documentFixture();
  const parent = modal(doc);
  const child = modal(doc);
  const releaseParent = open(parent, trigger);
  const releaseChild = open(child, parent.controls[0]);
  parent.controls[0].disabled = true;
  releaseChild();
  assert.equal(doc.activeElement, parent.dialog);
  trigger.isConnected = false;
  releaseParent();
  assert.notEqual(doc.activeElement, trigger);
});

test('scroll locks restore both axes and their priorities only after the last release', () => {
  const { doc } = documentFixture();
  doc.body.style.setProperty('overflow-x', 'clip');
  doc.body.style.setProperty('overflow-y', 'scroll', 'important');
  doc.documentElement.style.setProperty('overflow-y', 'auto');
  const releaseFirst = lockBackgroundScroll(doc);
  const releaseSecond = lockBackgroundScroll(doc);
  releaseFirst();
  releaseFirst();
  assert.equal(doc.body.style.getPropertyValue('overflow-y'), 'hidden');
  assert.equal(doc.documentElement.style.getPropertyPriority('overflow-y'), 'important');
  releaseSecond();
  assert.equal(doc.body.style.getPropertyValue('overflow-x'), 'clip');
  assert.equal(doc.body.style.getPropertyValue('overflow-y'), 'scroll');
  assert.equal(doc.body.style.getPropertyPriority('overflow-y'), 'important');
  assert.equal(doc.documentElement.style.getPropertyValue('overflow-y'), 'auto');
  assert.equal(doc.documentElement.style.getPropertyValue('overflow-x'), '');
});

test('scrollable app ancestors and parent modal content stay locked until every descendant closes', () => {
  const { doc } = documentFixture();
  const main = { style: style(), overflowY: 'auto', parentElement: doc.body };
  const content = { style: style(), overflowY: 'auto', parentElement: main };
  const parentDialog = { parentElement: main };
  const childDialog = { parentElement: content };
  const releaseParent = lockBackgroundScroll(doc, parentDialog);
  const releaseChild = lockBackgroundScroll(doc, childDialog);
  assert.equal(main.style.getPropertyValue('overflow-y'), 'hidden');
  assert.equal(content.style.getPropertyValue('overflow-y'), 'hidden');
  releaseParent();
  assert.equal(main.style.getPropertyValue('overflow-y'), 'hidden');
  releaseChild();
  assert.equal(main.style.getPropertyValue('overflow-y'), '');
  assert.equal(content.style.getPropertyValue('overflow-y'), '');
  assert.equal(doc.body.style.getPropertyValue('overflow-y'), '');
});

test('scroll restoration preserves unrelated changes and supports independent documents and remounts', () => {
  const { doc } = documentFixture();
  const { doc: otherDoc } = documentFixture();
  const release = lockBackgroundScroll(doc);
  const releaseOther = lockBackgroundScroll(otherDoc);
  doc.body.style.setProperty('overflow-y', 'clip');
  doc.body.style.setProperty('color', 'red');
  release();
  assert.equal(doc.body.style.getPropertyValue('overflow-y'), 'clip');
  assert.equal(doc.body.style.getPropertyValue('color'), 'red');
  assert.equal(otherDoc.body.style.getPropertyValue('overflow-y'), 'hidden');
  const releaseAgain = lockBackgroundScroll(doc);
  releaseAgain();
  assert.equal(doc.body.style.getPropertyValue('overflow-y'), 'clip');
  releaseOther();
  assert.equal(otherDoc.body.style.getPropertyValue('overflow-y'), '');
});
