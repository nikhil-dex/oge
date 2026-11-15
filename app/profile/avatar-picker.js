'use client';

import { useState } from 'react';
import { PROFILE_AVATARS } from '../../lib/profile-settings.js';

export default function AvatarPicker({ current = 'google', googleImage = null, initials = 'O' }) {
  const [selected, setSelected] = useState(current);
  return (
    <fieldset className="oge-avatar-fieldset">
      <legend>Choose a profile avatar</legend>
      <p>Use your Google picture or choose one of the built-in avatars. No upload required.</p>
      <div className="oge-avatar-grid">
        <label className={'oge-avatar-option' + (selected === 'google' ? ' is-selected' : '')}>
          <input type="radio" name="avatarId" value="google" checked={selected === 'google'} onChange={() => setSelected('google')} />
          <span className="oge-avatar-image oge-avatar-google">
            {googleImage ? <img src={googleImage} alt="" referrerPolicy="no-referrer" /> : initials.slice(0, 1).toUpperCase()}
          </span>
          <span>Google</span>
        </label>
        {PROFILE_AVATARS.map((avatar) => (
          <label key={avatar.id} className={'oge-avatar-option' + (selected === avatar.id ? ' is-selected' : '')}>
            <input type="radio" name="avatarId" value={avatar.id} checked={selected === avatar.id} onChange={() => setSelected(avatar.id)} />
            <span className={'oge-avatar-image oge-avatar-' + avatar.tone} aria-hidden="true">{avatar.emoji}</span>
            <span>{avatar.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
