export const ADMIN_TOKEN_STORAGE_KEY = 'tuchuang_admin_token';
export const USER_PROFILE_STORAGE_KEY = 'tuchuang_user_profile';

function safeGetItem(storage, key) {
  try {
    return storage?.getItem?.(key) || '';
  } catch {
    return '';
  }
}

function safeSetItem(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
  } catch {
    // Browser storage can be unavailable in private/sandboxed contexts.
  }
}

function parseStoredProfile(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function cleanHash(location, history, hashParams) {
  if (!history?.replaceState || !location) return;
  const nextHash = hashParams.toString();
  const nextUrl = `${location.origin || ''}${location.pathname || '/'}${location.search || ''}${nextHash ? `#${nextHash}` : ''}`;
  try {
    history.replaceState(null, '', nextUrl);
  } catch {
    // Do not block preload if history replacement is unavailable.
  }
}

export function preloadUserFromBrowserState({
  location = globalThis.location,
  storage = globalThis.localStorage,
  history = globalThis.history,
  now = () => new Date().toISOString()
} = {}) {
  const hash = String(location?.hash || '');
  const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const hashToken = hashParams.get('admin_token') || hashParams.get('token') || '';

  if (hashToken) {
    const displayName = hashParams.get('user') || hashParams.get('display_name') || hashParams.get('name') || '管理员';
    const userProfile = {
      displayName,
      role: 'admin',
      source: 'url-hash',
      preloadedAt: now()
    };

    safeSetItem(storage, ADMIN_TOKEN_STORAGE_KEY, hashToken);
    safeSetItem(storage, USER_PROFILE_STORAGE_KEY, JSON.stringify(userProfile));

    hashParams.delete('admin_token');
    hashParams.delete('token');
    hashParams.delete('user');
    hashParams.delete('display_name');
    hashParams.delete('name');
    cleanHash(location, history, hashParams);

    return { adminToken: hashToken, userProfile, importedFromHash: true };
  }

  const adminToken = safeGetItem(storage, ADMIN_TOKEN_STORAGE_KEY);
  const userProfile = parseStoredProfile(safeGetItem(storage, USER_PROFILE_STORAGE_KEY));
  return { adminToken, userProfile, importedFromHash: false };
}
