import Link from 'next/link';
import { auth } from '../../auth.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ownerMutationFilter } from '../../lib/active-owner-mutation.js';
import { isRecentOAuthAuthentication } from '../../lib/password-auth.js';
import { redirect } from 'next/navigation';
import { signOutOfOgeNotes } from '../settings/actions.js';
import { reauthenticateWithGoogle, reauthenticateWithGitHub, setLinkedPassword } from '../settings/password-actions.js';
import { saveProfileSettings } from './actions.js';
import { connectGoogleAccount } from './google-link-actions.js';
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
    { projection: { username: 1, displayName: 1, name: 1, email: 1, image: 1, avatarId: 1, passwordHash: 1, createdAt: 1, socialLinks: 1, identityProvider: 1, linkedGoogleSub: 1, linkedGithubOwnerId: 1 } },
  );
  if (!user) redirect('/register');
  const query = await searchParams;
  const status = query?.status;
  const passwordStatus = query?.password;
  const name = user.displayName || user.name || 'OgeNotes student';
  const isGitHubAccount = user.identityProvider === 'github' || ownerId.startsWith('github:');
  const providerLabel = isGitHubAccount ? 'GitHub' : 'Google';
  const googleConnected = Boolean(user.linkedGoogleSub || user.linkedGithubOwnerId);

  return (
    <main className="shell oge-shell oge-settings-page oge-profile-page oge-retro-workspace">
      <SiteNavbar actions={<Link className="oge-signin" href="/settings">Workspace settings →</Link>} />
      <div className="oge-retro-workspace-ribbon" aria-hidden="true"><span>✳ OGE / PERSONAL ARCHIVE</span><span>FIELD NOTES · VOL. 01</span><span>✦ MADE FOR CURIOUS MINDS</span></div>
      <section className="oge-settings-hero">
        <p className="oge-eyebrow"><span className="oge-status-dot" /> YOUR IDENTITY</p>
        <h1>Profile<span>.</span></h1>
        <span className="oge-retro-workspace-stamp" aria-hidden="true">✳<small>YOUR STORY</small></span>
        <p>Choose how you appear in OgeNotes, manage sign-in, and keep your account secure.</p>
      </section>
      <div className="oge-profile-layout">
        {(isGitHubAccount || googleConnected) && (
          <section className="oge-settings-card" aria-labelledby="profile-google-link-heading">
            <div className="oge-settings-card-heading">
              <div><span className="oge-section-kicker">ACCOUNT CONNECTION</span><h2 id="profile-google-link-heading">Google account</h2></div>
              <span className="oge-settings-pill">{googleConnected ? 'Connected' : 'Optional'}</span>
            </div>
            {!googleConnected && <p className="oge-settings-description">Connect Google if you also use it to sign in. This is always optional, even when your verified GitHub email matches an existing Google account.</p>}
            {googleConnected && <p role="status" className="oge-profile-success">Your Google and GitHub sign-ins are connected.</p>}
            {['mismatch', 'expired', 'failed', 'migration-required', 'limited', 'not-available'].includes(query?.google) && (
              <p role="alert" className="oge-password-error">{query.google === 'migration-required'
                ? 'Both accounts have separate content or settings. Nothing was merged or deleted. Account linking needs a reviewed migration before it can finish.'
                : query.google === 'mismatch'
                  ? 'Google verification did not match this account or the Google account is already connected elsewhere.'
                  : query.google === 'expired' ? 'The Google connection expired. Please try again.'
                    : query.google === 'limited' ? 'Too many attempts. Try again later.'
                      : 'Google connection could not be completed. Please try again.'}</p>
            )}
            {!googleConnected && isGitHubAccount && (
              <form action={connectGoogleAccount}>
                <button type="submit" className="oge-google-button">Connect Google account →</button>
              </form>
            )}
            <p className="oge-settings-note">Connecting requires a fresh Google sign-in and a matching verified email. Oge never combines separate notes or profile data without a safe migration.</p>
          </section>
        )}
        <section className="oge-settings-card" aria-labelledby="profile-heading">
          <div className="oge-settings-card-heading">
            <div><span className="oge-section-kicker">01 · IDENTITY</span><h2 id="profile-heading">Your profile</h2></div>
            <span className="oge-settings-pill">{providerLabel} verified</span>
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
            <div className="oge-profile-email"><strong>Verified email address</strong><span>{user.email}</span><small>Your {providerLabel}-verified email is read-only. Changing your profile never changes who owns your notes.</small></div>
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
          <p className="oge-settings-description">Sign in with {providerLabel}, or use your verified email address and a separate OgeNotes password after setting one.</p>
          <p className="oge-settings-note">{user.passwordHash ? 'Email/password sign-in is enabled.' : 'Email/password sign-in has not been set up yet.'}</p>
          {['invalid', 'reauth', 'limited', 'failed'].includes(passwordStatus) &&
            <p role="alert" className="oge-password-error">{passwordStatus === 'invalid' ? 'Passwords must match and contain 12–128 characters.' : passwordStatus === 'reauth' ? 'Verify your account provider again before changing the password.' : passwordStatus === 'limited' ? 'Too many attempts. Try again later.' : 'Password change was unsuccessful.'}</p>}
          {isRecentOAuthAuthentication(session) ? (
            <form action={setLinkedPassword} className="oge-password-login-form">
              <label htmlFor="new-oge-password">New OgeNotes password</label>
              <input id="new-oge-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
              <label htmlFor="confirm-oge-password">Confirm password</label>
              <input id="confirm-oge-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
              <button type="submit" className="oge-google-button">{user.passwordHash ? 'Change password' : 'Set password'} →</button>
              <small>Changing your password signs out all existing sessions.</small>
            </form>
          ) : (
            <form action={isGitHubAccount ? reauthenticateWithGitHub : reauthenticateWithGoogle}>
              <button type="submit" className="oge-google-button">Verify with {providerLabel} to set or reset password →</button>
            </form>
          )}
          <div className="oge-profile-help">
            <h3>Forgot your OgeNotes password?</h3>
            <p>Use {providerLabel} sign-in to verify your identity, then return here to set a replacement. Email-only password reset is not available yet.</p>
            <p>On shared college or library computers, use a private browser window and always sign out.</p>
          </div>
        </section>

        <section className="oge-settings-card" aria-labelledby="profile-account-heading">
          <div className="oge-settings-card-heading">
            <div><span className="oge-section-kicker">03 · ACCOUNT</span><h2 id="profile-account-heading">Account information</h2></div>
          </div>
          <p className="oge-settings-description">Account type: {providerLabel} verified. {user.createdAt ? 'Joined ' + new Date(user.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' }) + '.' : ''}</p>
          <form action={signOutOfOgeNotes} className="oge-settings-signout">
            <button className="oge-settings-danger-button" type="submit">Sign out →</button>
          </form>
          <p className="oge-settings-note">For data export, account deletion, subjects, news and appearance, visit <Link href="/settings">Workspace settings</Link>.</p>
        </section>
      </div>
    </main>
  );
}
