import Link from 'next/link';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { isRecentGoogleAuthentication } from '../../lib/password-auth.js';
import { redirect } from 'next/navigation';
import { signOutOfOgeNotes } from '../settings/actions.js';
import { reauthenticateWithGoogle, setLinkedPassword } from '../settings/password-actions.js';
import { saveProfileSettings } from './actions.js';
import AvatarPicker from './avatar-picker.js';
import SiteNavbar from '../components/site-navbar';

export const metadata = { title: 'Profile' };
export const dynamic = 'force-dynamic';

export default async function ProfilePage({ searchParams }) {
  const session = await auth();
  const ownerId = session?.user?.id;
  if (!ownerId) redirect('/register');
  const db = await getDatabase();
  const user = await db.collection('users').findOne(
    ownerMutationFilter(ownerId, { sessionVersion: session.user.sessionVersion }),
    { projection: { username: 1, displayName: 1, name: 1, email: 1, image: 1, avatarId: 1, passwordHash: 1, createdAt: 1, socialLinks: 1 } },
  );
  if (!user) redirect('/register');
  const query = await searchParams;
  const status = query?.status;
  const passwordStatus = query?.password;
  const name = user.displayName || user.name || 'OgeNotes student';

  return (
    <main className="shell oge-shell oge-settings-page oge-profile-page">
      <SiteNavbar actions={<Link className="oge-signin" href="/settings">Workspace settings →</Link>} />
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot" /> YOUR IDENTITY</p>
        <h1>Profile<span>.</span></h1>
        <p>Choose how you appear in OgeNotes, manage sign-in, and keep your account secure.</p>
      </section>
      <div className="oge-profile-layout">
        <section className="oge-settings-card" aria-labelledby="profile-heading">
          <div className="oge-settings-card-heading">
            <div><span className="oge-section-kicker">01 · IDENTITY</span><h2 id="profile-heading">Your profile</h2></div>
            <span className="oge-settings-pill">Google verified</span>
          </div>
          {status === 'saved' && <p className="oge-profile-success" role="status">Profile updated successfully.</p>}
          {status === 'invalid' && <p className="oge-password-error" role="alert">Check your display name, username, avatar selection, and social links. GitHub and LinkedIn must be profile URLs using HTTPS.</p>}
          {status === 'taken' && <p className="oge-password-error" role="alert">That username is already taken. Please choose another.</p>}
          {status === 'limited' && <p className="oge-password-error" role="alert">Too many changes. Try again later.</p>}
          <form action={saveProfileSettings} className="oge-profile-form">
            <div className="oge-profile-form-grid">
              <div>
                <label htmlFor="profile-display-name">Display name</label>
                <input id="profile-display-name" name="displayName" defaultValue={name} autoComplete="nickname" minLength={2} maxLength={60} required />
                <small>The name shown on your profile.</small>
              </div>
              <div>
                <label htmlFor="profile-username">Username</label>
                <input id="profile-username" name="username" defaultValue={user.username || ''} placeholder="your_username" autoCapitalize="none" autoComplete="off" minLength={3} maxLength={24} pattern="[a-zA-Z][a-zA-Z0-9_-]{1,22}[a-zA-Z0-9]" required />
                <small>Unique across OgeNotes, 3–24 characters. Start with a letter; use letters, numbers, hyphens or underscores; end with a letter or number.</small>
              </div>
            </div>
            <div className="oge-profile-email"><strong>Linked Gmail address</strong><span>{user.email}</span><small>Your Google-verified email is read-only. Changing your profile never changes who owns your notes.</small></div>
            <fieldset className="oge-social-links-fieldset">
              <legend>Social &amp; portfolio links</legend>
              <p>Optional links for your profile. These may be shown to other students if social features are added later.</p>
              <div className="oge-profile-form-grid">
                <div>
                  <label htmlFor="profile-github">GitHub</label>
                  <input id="profile-github" name="github" type="url" inputMode="url" autoComplete="url"
                    placeholder="https://github.com/username" maxLength={2048}
                    defaultValue={user.socialLinks?.github || ''} />
                  <small>Enter the full HTTPS link to your GitHub profile.</small>
                </div>
                <div>
                  <label htmlFor="profile-linkedin">LinkedIn</label>
                  <input id="profile-linkedin" name="linkedin" type="url" inputMode="url" autoComplete="url"
                    placeholder="https://www.linkedin.com/in/username" maxLength={2048}
                    defaultValue={user.socialLinks?.linkedin || ''} />
                  <small>Enter the full HTTPS link to your LinkedIn profile.</small>
                </div>
                <div>
                  <label htmlFor="profile-portfolio">Portfolio website</label>
                  <input id="profile-portfolio" name="portfolio" type="url" inputMode="url" autoComplete="url"
                    placeholder="https://your-portfolio.example.org" maxLength={2048}
                    defaultValue={user.socialLinks?.portfolio || ''} />
                  <small>Any public HTTPS portfolio website. Leave blank to hide it.</small>
                </div>
              </div>
            </fieldset>
            <AvatarPicker current={user.avatarId || 'google'} googleImage={user.image || null} initials={name} />
            <button className="oge-google-button" type="submit">Save profile changes →</button>
          </form>
        </section>

        <section className="oge-settings-card" aria-labelledby="profile-security-heading">
          <div className="oge-settings-card-heading">
            <div><span className="oge-section-kicker">02 · SECURITY</span><h2 id="profile-security-heading">Password & sign-in</h2></div>
          </div>
          <p className="oge-settings-description">Use Google, or sign in with your Gmail address and a separate OgeNotes password.</p>
          <p className="oge-settings-note">{user.passwordHash ? 'Email/password sign-in is enabled.' : 'Email/password sign-in has not been set up yet.'}</p>
          {['invalid', 'reauth', 'limited', 'failed'].includes(passwordStatus) &&
            <p role="alert" className="oge-password-error">{passwordStatus === 'invalid' ? 'Passwords must match and contain 12–128 characters.' : passwordStatus === 'reauth' ? 'Verify your Google account again before changing the password.' : passwordStatus === 'limited' ? 'Too many attempts. Try again later.' : 'Password change was unsuccessful.'}</p>}
          {isRecentGoogleAuthentication(session) ? (
            <form action={setLinkedPassword} className="oge-password-login-form">
              <label htmlFor="new-oge-password">New OgeNotes password</label>
              <input id="new-oge-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
              <label htmlFor="confirm-oge-password">Confirm password</label>
              <input id="confirm-oge-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
              <button type="submit" className="oge-google-button">{user.passwordHash ? 'Change password' : 'Set password'} →</button>
              <small>Changing your password signs out all existing sessions.</small>
            </form>
          ) : (
            <form action={reauthenticateWithGoogle}>
              <button type="submit" className="oge-google-button">Verify with Google to set or reset password →</button>
            </form>
          )}
          <div className="oge-profile-help">
            <h3>Forgot your OgeNotes password?</h3>
            <p>Use Google sign-in to verify your identity, then return here to set a replacement. Email-only password reset is not available yet.</p>
            <p>On shared college or library computers, use a private browser window and always sign out.</p>
          </div>
        </section>

        <section className="oge-settings-card" aria-labelledby="profile-account-heading">
          <div className="oge-settings-card-heading">
            <div><span className="oge-section-kicker">03 · ACCOUNT</span><h2 id="profile-account-heading">Account information</h2></div>
          </div>
          <p className="oge-settings-description">Account type: Google verified. {user.createdAt ? 'Joined ' + new Date(user.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' }) + '.' : ''}</p>
          <form action={signOutOfOgeNotes} className="oge-settings-signout">
            <button className="oge-settings-danger-button" type="submit">Sign out →</button>
          </form>
          <p className="oge-settings-note">For data export, account deletion, subjects, news and appearance, visit <Link href="/settings">Workspace settings</Link>.</p>
        </section>
      </div>
    </main>
  );
}
