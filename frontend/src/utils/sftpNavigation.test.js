import test from 'node:test';
import assert from 'node:assert/strict';
import { createSftpNavigation } from './sftpNavigation.js';

function createBrowser() {
  const navigation = createSftpNavigation();
  const state = { path: '.', entries: [], loading: false, error: null, initialLoaded: false };
  const load = (path, response) => navigation.load(path, () => response, {
    onStart: () => { state.loading = true; state.error = null; },
    onSuccess: (data, confirmedPath) => {
      state.entries = data.entries;
      state.path = confirmedPath;
      state.initialLoaded = true;
    },
    onError: (error) => { state.error = error; },
    onFinish: () => { state.loading = false; },
  });
  return { navigation, state, load };
}

const listing = (path) => ({ path, entries: [{ name: `${path}/file`, type: 'file' }] });

test('reverse-order listings commit only the newest directory and entries', async () => {
  const { navigation, state, load } = createBrowser();
  const a = Promise.withResolvers();
  const b = Promise.withResolvers();
  const first = load('/a', a.promise);
  const second = load('/b', b.promise);
  assert.equal(navigation.getMutationTarget('.'), null);

  b.resolve(listing('/b'));
  await second;
  assert.deepEqual(state, {
    path: '/b', entries: listing('/b').entries, loading: false, error: null, initialLoaded: true,
  });
  const target = navigation.getMutationTarget('/b');
  assert.equal(target.path, '/b');

  a.resolve(listing('/a'));
  await first;
  assert.equal(state.path, '/b');
  assert.deepEqual(state.entries, listing('/b').entries);
  assert.equal(state.loading, false);
  assert.equal(target.isCurrent(), true);
});

test('an older listing cannot finish loading or enable mutations while the latest is pending', async () => {
  const { navigation, state, load } = createBrowser();
  await load('/home', Promise.resolve(listing('/home')));
  const a = Promise.withResolvers();
  const b = Promise.withResolvers();
  const first = load('/a', a.promise);
  const second = load('/b', b.promise);

  a.resolve(listing('/a'));
  await first;
  assert.equal(state.path, '/home');
  assert.deepEqual(state.entries, listing('/home').entries);
  assert.equal(state.loading, true);
  assert.equal(navigation.getMutationTarget('/home'), null);

  b.resolve(listing('/b'));
  await second;
  assert.equal(state.loading, false);
  assert.equal(navigation.getMutationTarget('/b').path, '/b');
});

for (const [name, error] of [
  ['network error', new Error('Network Error')],
  ['expired session', { response: { status: 403, data: { code: 'SFTP_SESSION_EXPIRED' } } }],
]) {
  test(`a stale ${name} cannot overwrite a successful newer listing`, async () => {
    const { state, load } = createBrowser();
    const a = Promise.withResolvers();
    const first = load('/a', a.promise);
    await load('/b', Promise.resolve(listing('/b')));

    a.reject(error);
    await first;
    assert.equal(state.error, null);
    assert.equal(state.path, '/b');
    assert.equal(state.loading, false);
  });
}

test('a failed latest navigation keeps the previous confirmed path and ignores an older success', async () => {
  const { navigation, state, load } = createBrowser();
  await load('/home', Promise.resolve(listing('/home')));
  const a = Promise.withResolvers();
  const first = load('/a', a.promise);
  const error = new Error('Permission denied');
  await load('/b', Promise.reject(error));
  assert.equal(state.error, error);
  assert.equal(state.loading, false);
  assert.equal(navigation.getMutationTarget('/b'), null);
  assert.equal(navigation.getMutationTarget('/home').path, '/home');

  a.resolve(listing('/a'));
  await first;
  assert.equal(state.path, '/home');
  assert.deepEqual(state.entries, listing('/home').entries);
  assert.equal(state.error, error);
});

test('mutations need a successful listing and use its canonical path', async () => {
  const { navigation, load } = createBrowser();
  assert.equal(navigation.getMutationTarget('.'), null);
  await load('.', Promise.reject(new Error('Not connected')));
  assert.equal(navigation.getMutationTarget('.'), null);

  await load('.', Promise.resolve(listing('/home/user')));
  assert.equal(navigation.getMutationTarget('.'), null);
  assert.equal(navigation.getMutationTarget('/home/user').path, '/home/user');
  await load('/fallback', Promise.resolve({ entries: [] }));
  assert.equal(navigation.getMutationTarget('/fallback').path, '/fallback');
});

test('a mutation retains its target but cannot refresh it after a newer navigation, even back to the same path', async () => {
  const { navigation, load } = createBrowser();
  await load('/a', Promise.resolve(listing('/a')));
  const target = navigation.getMutationTarget('/a');
  assert.equal(target.isCurrent(), true);

  const b = Promise.withResolvers();
  const next = load('/b', b.promise);
  assert.equal(target.path, '/a');
  assert.equal(target.isCurrent(), false);
  assert.equal(navigation.getMutationTarget('/a'), null);
  b.resolve(listing('/b'));
  await next;
  assert.equal(navigation.getMutationTarget('/a'), null);

  await load('/a', Promise.resolve(listing('/a')));
  assert.equal(target.isCurrent(), false);
  assert.equal(navigation.getMutationTarget('/a').isCurrent(), true);
});

for (const order of [['delete', 'mkdir'], ['mkdir', 'delete']]) {
  test(`overlapping delete and mkdir refresh /a after each completion, ${order[0]} first`, async () => {
    const { navigation, state, load } = createBrowser();
    let remoteEntries = [{ name: 'old-file', type: 'file' }];
    await load('/a', Promise.resolve({ path: '/a', entries: [...remoteEntries] }));
    const responses = { delete: Promise.withResolvers(), mkdir: Promise.withResolvers() };
    const completed = [];
    const refreshPaths = [];
    const mutate = async (action) => {
      const target = navigation.getMutationTarget(state.path);
      assert.ok(target);
      await responses[action].promise;
      if (action === 'delete') remoteEntries = remoteEntries.filter((entry) => entry.name !== 'old-file');
      else remoteEntries.push({ name: 'new-folder', type: 'directory' });
      if (!target.isCurrent()) return;
      completed.push(action);
      refreshPaths.push(target.path);
      await load(target.path, Promise.resolve({ path: target.path, entries: [...remoteEntries] }));
    };
    const mutations = { delete: mutate('delete'), mkdir: mutate('mkdir') };

    responses[order[0]].resolve();
    await mutations[order[0]];
    assert.deepEqual(completed, [order[0]]);
    assert.deepEqual(state.entries, remoteEntries);
    assert.equal(state.loading, false);

    responses[order[1]].resolve();
    await mutations[order[1]];
    assert.deepEqual(completed, order);
    assert.deepEqual(refreshPaths, ['/a', '/a']);
    assert.equal(state.path, '/a');
    assert.deepEqual(state.entries, [{ name: 'new-folder', type: 'directory' }]);
    assert.equal(state.loading, false);
  });
}

test('overlapping mutation refreshes keep the newest listing when refresh responses arrive in reverse order', async () => {
  const { navigation, state, load } = createBrowser();
  await load('/a', Promise.resolve(listing('/a')));
  const deletionTarget = navigation.getMutationTarget('/a');
  const creationTarget = navigation.getMutationTarget('/a');
  const afterDelete = Promise.withResolvers();
  const afterMkdir = Promise.withResolvers();
  const firstRefresh = load(deletionTarget.path, afterDelete.promise);
  assert.equal(creationTarget.isCurrent(), true);
  assert.equal(navigation.getMutationTarget('/a'), null);
  const secondRefresh = load(creationTarget.path, afterMkdir.promise);

  afterMkdir.resolve({ path: '/a', entries: [{ name: 'new-folder', type: 'directory' }] });
  await secondRefresh;
  afterDelete.resolve({ path: '/a', entries: [] });
  await firstRefresh;
  assert.equal(state.path, '/a');
  assert.deepEqual(state.entries, [{ name: 'new-folder', type: 'directory' }]);
  assert.equal(state.loading, false);
});

for (const destinationLoaded of [false, true]) {
  test(`a pending mutation in /a cannot refresh over ${destinationLoaded ? 'confirmed' : 'pending'} navigation to /b`, async () => {
    const { navigation, state, load } = createBrowser();
    await load('/a', Promise.resolve(listing('/a')));
    const responses = { delete: Promise.withResolvers(), mkdir: Promise.withResolvers() };
    const completed = [];
    const mutate = async (action) => {
      const target = navigation.getMutationTarget(state.path);
      assert.ok(target);
      await responses[action].promise;
      if (!target.isCurrent()) return;
      completed.push(action);
      await load(target.path, Promise.resolve({ path: target.path, entries: [] }));
    };
    const deletion = mutate('delete');
    const creation = mutate('mkdir');
    responses.delete.resolve();
    await deletion;
    const destination = Promise.withResolvers();
    const switching = load('/b', destination.promise);
    if (destinationLoaded) {
      destination.resolve(listing('/b'));
      await switching;
    }

    responses.mkdir.resolve();
    await creation;
    assert.deepEqual(completed, ['delete']);
    assert.equal(state.path, destinationLoaded ? '/b' : '/a');
    assert.equal(state.loading, !destinationLoaded);
    if (!destinationLoaded) {
      destination.resolve(listing('/b'));
      await switching;
    }
    assert.equal(state.path, '/b');
    assert.deepEqual(state.entries, listing('/b').entries);
    assert.equal(state.loading, false);
  });
}

test('cleanup invalidates pending listings and mutation targets', async () => {
  const { navigation, state, load } = createBrowser();
  await load('/home', Promise.resolve(listing('/home')));
  const target = navigation.getMutationTarget('/home');
  const pending = Promise.withResolvers();
  const request = load('/a', pending.promise);
  navigation.invalidate();
  const before = { ...state };
  pending.resolve(listing('/a'));
  await request;

  assert.deepEqual(state, before);
  assert.equal(target.isCurrent(), false);
  assert.equal(navigation.getMutationTarget('/home'), null);
});
