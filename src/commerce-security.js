/** Public commerce APIs expose only explicit customer-safe projections. */
export class CommerceError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validZip = (zip) =>
  typeof zip === 'string' && /^\d{5}(?:-\d{4})?$/.test(zip) && !zip.startsWith('000');
export const localRequest = (request) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
export const reply = (body, status = 200, extra = {}) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    }
  });
export async function digest(value) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function sessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  return cookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('softnest-commerce='))
    ?.split('=')[1];
}
export async function ownerHash(request) {
  const token = sessionToken(request);
  if (!/^[0-9a-f]{64}$/.test(token || ''))
    throw new CommerceError(
      'session_required',
      'Refresh this page to start a private cart session.',
      401
    );
  return digest(token);
}
export function sessionResponse(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
    return reply({ error: 'Origin rejected' }, 403);
  let token = sessionToken(request);
  if (!/^[0-9a-f]{64}$/.test(token || '')) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return reply({ customerCheckoutEnabled: false, cjFulfillmentEnabled: false }, 200, {
    'Set-Cookie': `softnest-commerce=${token}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=86400${localRequest(request) ? '' : '; Secure'}`
  });
}
export async function readJson(request, limit = 5000) {
  if (request.headers.get('Origin') !== new URL(request.url).origin)
    throw new CommerceError('origin_rejected', 'Origin rejected', 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || ''))
    throw new CommerceError('json_required', 'JSON required', 415);
  if (Number(request.headers.get('Content-Length')) > limit)
    throw new CommerceError('body_too_large', 'Request too large', 413);
  // Stream with a bound rather than allocating an unbounded request body.
  const reader = request.body?.getReader();
  if (!reader) throw new CommerceError('invalid_json', 'Invalid JSON', 400);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new CommerceError('body_too_large', 'Request too large', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CommerceError('invalid_json', 'Invalid JSON', 400);
  }
}
export function publicError(error) {
  if (error instanceof CommerceError)
    return reply({ error: error.message, code: error.code }, error.status);
  return reply(
    {
      error: 'This service is temporarily unavailable. Please try again later.',
      code: 'temporarily_unavailable'
    },
    503
  );
}
