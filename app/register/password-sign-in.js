'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

export default function PasswordSignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await signIn('credentials', { email, password, redirect: false });
      if (!result || result.error || !result.ok) {
        setError('Invalid email or password. You can also sign in with Google or GitHub.');
        return;
      }
      window.location.assign('/');
    } catch {
      setError('Sign-in unavailable. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="oge-password-login-form" onSubmit={submit}>
      <label htmlFor="oge-login-email">Email address</label>
      <input id="oge-login-email" type="email" name="email" autoComplete="username"
        required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)}
        placeholder="student@example.com" />
      <label htmlFor="oge-login-password">OgeNotes password</label>
      <input id="oge-login-password" type="password" name="password" autoComplete="current-password"
        required value={password} onChange={(event) => setPassword(event.target.value)} />
      {error && <p role="alert" className="oge-password-error">{error}</p>}
      <button className="oge-google-button" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in with password'} <span aria-hidden="true">→</span>
      </button>
      <small>Available after you set a password on your Profile page. Forgot it? Sign in with your original Google or GitHub provider, then visit Profile to replace it.</small>
      <small>On shared computers, use a private window and sign out when finished. Password sessions expire after 8 hours.</small>
    </form>
  );
}
