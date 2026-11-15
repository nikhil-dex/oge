import Link from 'next/link';
import { auth } from '../../auth.js';
import { redirect } from 'next/navigation';
import { signInWithGoogle, signInWithGitHub } from './actions.js';
import PasswordSignIn from './password-sign-in.js';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage({ searchParams }) {
  const session = await auth();
  const query = await searchParams;
  if (session?.user?.id) redirect('/');

  return (
    <main className="oge-register-page oge-retro-login">
      <div className="oge-retro-wrap">
        <header className="oge-retro-header">
          <Link className="oge-retro-brand" href="/" aria-label="OgeNotes home">
            <span className="oge-retro-logo" aria-hidden="true">O<span>✳</span></span>
            <span>OGE<span>NOTES</span></span>
          </Link>
          <span className="oge-retro-header-caption">YOUR LITTLE CORNER OF THE INTERNET <span aria-hidden="true">✦</span> EST. 2026</span>
        </header>

        <div className="oge-retro-stage">
          <section className="oge-retro-story" aria-label="Welcome to OgeNotes">
            <div className="oge-retro-stamp"><span>FOR THE CURIOUS</span><strong>VOL. 01</strong></div>
            <p className="oge-retro-overline"><span aria-hidden="true">✳</span> A HOME FOR YOUR BRIGHT IDEAS</p>
            <h1>Keep what<br /><em>matters.</em></h1>
            <p className="oge-retro-intro">Big ideas, little discoveries, midnight thoughts. Give them a place to grow.</p>
            <div className="oge-retro-art" aria-hidden="true">
              <div className="oge-retro-orbit oge-retro-orbit-one" />
              <div className="oge-retro-orbit oge-retro-orbit-two" />
              <div className="oge-retro-art-spark oge-retro-art-spark-one">✳</div>
              <div className="oge-retro-art-spark oge-retro-art-spark-two">✦</div>
              <div className="oge-retro-sheet oge-retro-sheet-back">
                <span className="oge-retro-paper-kicker">FIELD NOTES / 001</span>
                <span className="oge-retro-paper-rule" />
                <span className="oge-retro-paper-rule short" />
              </div>
              <div className="oge-retro-sheet oge-retro-sheet-front">
                <span className="oge-retro-paper-kicker">THE IDEA BOOK</span>
                <span className="oge-retro-paper-title">Make room<br />for wonder<span>.</span></span>
                <span className="oge-retro-paper-doodle">✻</span>
                <span className="oge-retro-paper-foot">01 / KEEP EXPLORING</span>
              </div>
              <div className="oge-retro-art-label">GOOD IDEAS DESERVE TO STAY.</div>
            </div>
            <div className="oge-retro-story-bottom">
              <span>NOTES <i>✳</i> LINKS <i>✳</i> LEARNING</span>
              <span>MADE FOR CURIOUS MINDS</span>
            </div>
          </section>

          <section className="oge-retro-auth" aria-labelledby="oge-retro-auth-title">
            <div className="oge-retro-auth-top">
              <span className="oge-retro-signature">✦ WELCOME BACK ✦</span>
              <span className="oge-retro-ticket">ADMIT ONE</span>
            </div>
            <div className="oge-retro-auth-content">
              <span className="oge-retro-number">01 — THE BEGINNING</span>
              <h2 id="oge-retro-auth-title">Your ideas<br /><em>are waiting.</em></h2>
              <p className="oge-retro-auth-lede">Sign in or create your account to pick up right where inspiration left you.</p>

              {query?.password === 'enabled' && <p role="status" className="oge-password-success">OgeNotes password saved. Sign in again to continue.</p>}
              {query?.error && <p role="alert" className="oge-password-error">Sign-in could not be completed. Check that your provider account has a verified email and try again.</p>}

              <div className="oge-social-login-options">
                <form action={signInWithGoogle}>
                  <button className="oge-google-button" type="submit"><span className="oge-google-g" aria-hidden="true">G</span> Continue with Google <span aria-hidden="true">↗</span></button>
                </form>
                <form action={signInWithGitHub}>
                  <button className="oge-google-button oge-github-login-button" type="submit"><span className="oge-github-login-mark" aria-hidden="true">GH</span> Continue with GitHub <span aria-hidden="true">↗</span></button>
                </form>
              </div>

              <p className="oge-login-separator"><span>OR USE YOUR OGEnotes PASSWORD</span></p>
              <PasswordSignIn />
              <p className="oge-register-footnote">By continuing, you agree to use OgeNotes in accordance with its privacy and service terms.</p>
            </div>
            <div className="oge-retro-auth-bottom"><span>TAKE NOTES. MAKE MEMORIES.</span><span aria-hidden="true">✳</span><span>YOU BELONG HERE.</span></div>
          </section>
        </div>
        <footer className="oge-retro-page-footer"><span>© 2026 OGENOTES</span><span>A QUIETER PLACE TO THINK.</span><span>BUILT FOR WHAT&apos;S NEXT ✳</span></footer>
      </div>
    </main>
  );
}
