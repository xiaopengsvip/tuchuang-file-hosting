export function normalizePathname(input = '/') {
  try {
    return new URL(input, 'http://local.test').pathname;
  } catch {
    return String(input || '/').split('?')[0] || '/';
  }
}

export function routeRequiresAdmin(method = 'GET', url = '/') {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const pathname = normalizePathname(url);

  if (normalizedMethod === 'DELETE' && pathname.startsWith('/api/files/')) return true;
  if (normalizedMethod === 'PATCH' && /^\/api\/files\/[^/]+\/feed$/.test(pathname)) return true;
  if (pathname.startsWith('/api/admin/')) return true;
  if (normalizedMethod === 'POST' && pathname === '/api/notes') return true;
  if (normalizedMethod === 'DELETE' && pathname.startsWith('/api/notes/')) return true;
  return false;
}

export function sanitizePublicRecord(record = {}) {
  const { uploaderIp, ...publicFields } = record || {};
  return publicFields;
}
