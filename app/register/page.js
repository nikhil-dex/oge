import { auth } from '../../auth.js';
import { redirect } from 'next/navigation';
import { signInWithGoogle } from './actions.js';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  const session = await auth();
  if (session?.user?.id) redirect('/');
  return (
    <main className="shell oge-placeholder oge-register-page">
      <a className="oge-brand" href="/"><span className="oge-brand-mark">O</span><span>OgeNotes</span></a>
      <div className="oge-eyebrow"><span className="oge-status-dot" /> YOUR PERSONAL KNOWLEDGE SPACE</div>
      <h1>Keep what<br /><span>matters.</span></h1>
      <p className="oge-placeholder-copy">Sign in to keep your notes, links, and learning workflow together.</p>
      <form action={signInWithGoogle}>
        <button className="oge-google-button" type="submit"><span className="oge-google-g" aria-hidden="true">G</span> Continue with Google <span aria-hidden="true">→</span></button>
      </form>
      <p className="oge-register-footnote">By continuing, you agree to use OgeNotes in accordance with its privacy and service terms.</p>
    </main>
  );
}
