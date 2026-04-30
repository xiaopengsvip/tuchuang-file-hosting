import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_TOKEN_STORAGE_KEY,
  USER_PROFILE_STORAGE_KEY,
  preloadUserFromBrowserState
} from '../src/userPreload.js';

function makeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    dump: () => Object.fromEntries(store.entries())
  };
}

test('preloads admin token and user profile from URL hash without sending token in query', () => {
  const storage = makeStorage();
  const replaceCalls = [];
  const location = {
    href: 'https://tc.allapple.top/#admin_token=tc_admin_secret&user=%E7%AE%A1%E7%90%86%E5%91%98&theme=dark',
    origin: 'https://tc.allapple.top',
    pathname: '/',
    search: '',
    hash: '#admin_token=tc_admin_secret&user=%E7%AE%A1%E7%90%86%E5%91%98&theme=dark'
  };

  const result = preloadUserFromBrowserState({
    location,
    storage,
    history: { replaceState: (...args) => replaceCalls.push(args) },
    now: () => '2026-04-30T06:00:00.000Z'
  });

  assert.equal(result.adminToken, 'tc_admin_secret');
  assert.equal(result.userProfile.displayName, '管理员');
  assert.equal(result.userProfile.source, 'url-hash');
  assert.equal(result.importedFromHash, true);
  assert.equal(storage.getItem(ADMIN_TOKEN_STORAGE_KEY), 'tc_admin_secret');
  assert.deepEqual(JSON.parse(storage.getItem(USER_PROFILE_STORAGE_KEY)), {
    displayName: '管理员',
    role: 'admin',
    source: 'url-hash',
    preloadedAt: '2026-04-30T06:00:00.000Z'
  });
  assert.equal(replaceCalls.length, 1);
  assert.equal(replaceCalls[0][2], 'https://tc.allapple.top/#theme=dark');
});

test('preloads existing local user profile and token when URL hash has no token', () => {
  const storage = makeStorage({
    [ADMIN_TOKEN_STORAGE_KEY]: 'stored_token',
    [USER_PROFILE_STORAGE_KEY]: JSON.stringify({ displayName: '站长', role: 'admin', source: 'localStorage' })
  });

  const result = preloadUserFromBrowserState({
    location: { origin: 'https://tc.allapple.top', pathname: '/', search: '', hash: '' },
    storage,
    history: { replaceState: () => { throw new Error('should not clean URL'); } }
  });

  assert.equal(result.adminToken, 'stored_token');
  assert.equal(result.userProfile.displayName, '站长');
  assert.equal(result.importedFromHash, false);
});

test('ignores unsafe query token preload so admin tokens are not encouraged in server logs', () => {
  const storage = makeStorage();
  const result = preloadUserFromBrowserState({
    location: {
      origin: 'https://tc.allapple.top',
      pathname: '/',
      search: '?admin_token=query_secret',
      hash: ''
    },
    storage,
    history: { replaceState: () => { throw new Error('should not clean query token'); } }
  });

  assert.equal(result.adminToken, '');
  assert.equal(result.userProfile, null);
  assert.equal(storage.getItem(ADMIN_TOKEN_STORAGE_KEY), null);
});
