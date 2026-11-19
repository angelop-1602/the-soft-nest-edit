(() => {
  const form = document.getElementById('local-admin-login');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button'),
      message = document.getElementById('login-message');
    button.disabled = true;
    try {
      const response = await fetch('/admin/products/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code: document.getElementById('local-code').value }),
        cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
      document.getElementById('local-code').value = '';
      location.assign('/admin/products/');
    } catch (error) {
      message.textContent = error.message;
      button.disabled = false;
    }
  });
})();
