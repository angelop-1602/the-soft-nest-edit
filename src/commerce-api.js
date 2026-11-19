import { cartView, quoteShipping, selections } from './cj-shipping.js';
import { ownerHash, readJson, reply, sessionResponse, publicError } from './commerce-security.js';

export async function handleCommerce(request, env, route) {
  if (!['session', 'cart', 'shipping'].includes(route)) return reply({ error: 'Not found' }, 404);
  if (request.method !== (route === 'session' ? 'GET' : 'POST'))
    return reply({ error: 'Method not allowed' }, 405);
  if (route === 'session') return sessionResponse(request);
  try {
    const payload = await readJson(request);
    const items = selections(payload);
    if (route === 'cart') return reply(await cartView(env, items));
    return reply(await quoteShipping(env, await ownerHash(request), items, payload.zip));
  } catch (error) {
    return publicError(error);
  }
}
