/** Browser-only test controls. No PayPal client secrets or live checkout. */
(() => {
  'use strict';
  const start = document.getElementById('paypal-sandbox-start');
  if (!start) return;
  const capture = document.getElementById('paypal-sandbox-capture');
  const message = document.getElementById('paypal-sandbox-status');
  const url = new URL(location.href);
  const checkoutId = url.searchParams.get('checkoutId');
  const result = url.searchParams.get('result');
  const apiBase = '/api/paypal/sandbox/';
  let ready = false;

  async function api(path, method = 'GET', body = undefined) {
    const response = await fetch(apiBase + path, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store', credentials: 'same-origin'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Checkout temporarily unavailable');
    return data;
  }
  const setMessage = value => { message.textContent = value; };

  async function initialize() {
    try {
      const config = await api('config');
      if (config.environment !== 'sandbox' || config.liveCheckoutEnabled !== false)
        throw new Error('Sandbox configuration invalid');
      ready = true;
      if (!checkoutId) {
        start.disabled = false;
        setMessage('Ready for a PayPal Sandbox payment test. Use a PayPal Sandbox buyer account.');
        return;
      }
      if (!/^[0-9a-f-]{36}$/i.test(checkoutId)) throw new Error('Invalid test reference');
      start.hidden = true;
      const state = await api('status?checkoutId=' + encodeURIComponent(checkoutId));
      if (state.status === 'paid') {
        setMessage('Success: PayPal Sandbox payment verified. No CJ order was placed.');
      } else if (state.status === 'created' && result === 'approved') {
        capture.hidden = false;
        setMessage('You returned from PayPal Sandbox. Click the button to verify and capture the test payment.');
      } else if (result === 'canceled') {
        setMessage('You canceled the Sandbox checkout. No payment was captured.');
      } else if (state.status === 'needs_review' || state.status === 'capturing') {
        setMessage('Payment status needs review. Check PayPal Sandbox activity before trying again.');
      } else {
        setMessage('This sandbox checkout is not yet approved. Return to PayPal to approve it.');
      }
    } catch (error) {
      ready = false;
      start.disabled = true;
      capture.hidden = true;
      setMessage(error.message);
    }
  }
  start.addEventListener('click', async () => {
    if (!ready) return;
    start.disabled = true;
    setMessage('Creating a PayPal Sandbox checkout…');
    try {
      const data = await api('create', 'POST', {});
      if (data.environment !== 'sandbox' || typeof data.approvalUrl !== 'string')
        throw new Error('Invalid PayPal response');
      const u = new URL(data.approvalUrl);
      if (u.protocol !== 'https:' || !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(u.hostname))
        throw new Error('Unexpected PayPal destination');
      location.assign(u.href);
    } catch (error) {
      setMessage(error.message);
      start.disabled = false;
    }
  });
  capture.addEventListener('click', async () => {
    if (!ready || !checkoutId) return;
    capture.disabled = true;
    setMessage('Verifying your Sandbox payment with PayPal…');
    try {
      const data = await api('capture', 'POST', { checkoutId });
      if (data.status !== 'paid') throw new Error('Payment is not confirmed');
      capture.hidden = true;
      setMessage('Success: PayPal Sandbox payment verified. No real payment or CJ order was created.');
      history.replaceState(null, '', url.pathname);
    } catch (error) {
      capture.hidden = true;
      setMessage(error.message + ' Do not retry an uncertain capture.');
    }
  });
  initialize();
})();
