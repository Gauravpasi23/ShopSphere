const form = document.getElementById('login-form');
const errorMessage = document.getElementById('login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.textContent = '';
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;

  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        email: form.email.value,
        password: form.password.value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Sign-in failed.');
    window.location.assign('/admin');
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
