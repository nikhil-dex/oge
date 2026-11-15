import Link from 'next/link';
import { auth } from '../../auth.js';
import { redirect } from 'next/navigation';
import { signInWithGoogle } from './actions.js';
import PasswordSignIn from './password-sign-in.js';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage({ searchParams }) {
  const session = await auth();
  const query = await searchParams;
  if (session?.user?.id) redirect('/');
  return (
    <main className="shell oge-placeholder oge-register-page">
      <Link className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></Link>
      <div className="oge-eyebrow"><span className="oge-status-dot" /> YOUR PERSONAL KNOWLEDGE SPACE</div>
      <h1>Keep what<br /><span>matters.</span></h1>
      <p className="oge-placeholder-copy">Sign in to keep your notes, links, and learning workflow together.</p>
      {query?.password === 'enabled' && <p role="status" className="oge-password-success">OgeNotes password saved. Sign in again to continue.</p>}
      <PasswordSignIn />
      <p className="oge-login-separator">or</p>
      <form action={signInWithGoogle}>
        <button className="oge-google-button" type="submit"><span className="oge-google-g" aria-hidden="true">G</span> Continue with Google <span aria-hidden="true">→</span></button>
      </form>
      <p className="oge-register-footnote">By continuing, you agree to use OgeNotes in accordance with its privacy and service terms.</p>
    </main>
  );
}
