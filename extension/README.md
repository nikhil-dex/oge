# OgeNotes floating study toolbelt

The Chrome Manifest V3 extension now combines the original OgeNotes floating Quick Notes feature with the new Oge tools:

- **Quick Note:** write while browsing. When your GitHub Vault is connected, select a subject and press **Save to GitHub Vault**; otherwise the original Quick Notes behavior remains available.
- **Save URL:** save the current page in Saved Links.
- **My Links:** view the GitHub, LinkedIn and portfolio URLs saved in Profile, and copy or visit them.
- A draggable **O** button appears at the bottom right of regular HTTP and HTTPS pages. The existing extension popup remains available for token setup, saving tabs, and profile links.

## Install and connect

1. In Chrome, visit `chrome://extensions`, turn on Developer mode, and click **Load unpacked**. Select the `extension/` directory of the **oge** repository.
2. Sign in to your OgeNotes site and open **Browser Extension**. Generate an extension token.
3. Open the Chrome extension popup, choose **Connect**, paste the site origin (such as `http://localhost:3000` for local development) and the token, and click **Save connection**. Approve host permission.
4. **Reload existing website tabs** to inject the widget, click the floating **O** button, and use any of the three tools. The header can be dragged.
5. Connected Vault captures appear in **GitHub Notes** under the selected subject; other accounts still use **Quick Notes**. Saved tabs appear in **Saved Links**.

## Security and limitations

- The content script never reads or receives the connection token. The extension's background service worker reads the token from `chrome.storage.local` and talks to token-authenticated OgeNotes APIs.
- The original Quick Notes endpoint remains available for accounts without a connected Vault. Connected accounts use a separate explicit `/api/extension/vault-note` route that saves directly to their existing private GitHub repository (no permanent Note body is stored in MongoDB).
- This feature adds Chrome host-page content-script access so the floating widget can be injected. Chrome may display an updated permission notice when the extension reloads.
- The floating widget is injected into the top document of ordinary HTTP/HTTPS websites, **not** browser-internal pages (`chrome://`), the Chrome Web Store, PDFs rendered in internal viewers, or sites where Chrome prevents injection.
- It intentionally does not scrape or transmit web-page content. Only text you enter and the URL of a page you explicitly save are sent.
- Browser behavior, keyboard shortcuts, connection revocation, and clipboard fallback require manual Chrome validation before deployment.
- To revoke access, use the Browser Extension page in OgeNotes; deleting the local token alone is not server-side revocation.

## Choose a subject when capturing

In the floating Quick Note editor, **Save to** loads your available subjects. If your account has a connected Vault and the GitHub Notes editor is enabled, the widget chooses the first subject when available and displays **Save to GitHub Vault**. The first line becomes the heading; text below it becomes the body. **No subject is selected?** Add one in Oge's Quick Capture page. For accounts without a connected Vault, the original standalone Quick Notes and subject-based legacy behavior remains unchanged. An older extension build will receive an instruction to update instead of silently duplicating permanent MongoDB Notes for a connected Vault account.

## Reset the extension

In the toolbar popup, select **Connect → Reset extension** and confirm. This clears only the saved app URL, token and category from Chrome's extension storage, and empties the popup's current profile-link list. It does not remove any server-side notes, subjects or profile links, and it does not revoke the token on the server. For security, revoke an unwanted token from the **Browser Extension** page in OgeNotes before generating a replacement.

## Moving, resizing and inactivity

- **Move without opening:** drag the collapsed floating **O** button directly to a convenient spot on the screen. A short click still opens or closes the toolbelt. When open, the header also moves the widget.
- **Resize:** drag either bottom corner of the open panel to change its **width and height**, or use Chrome's native resizing on the bottom-right edge. Dimensions are constrained to the available browser viewport.
- **Compact view:** controls have reduced padding and a smaller initial panel to avoid covering the webpage unnecessarily.
- **Idle fade:** after approximately 12 seconds without mouse, wheel, touch or keyboard activity the closed launcher fades to ~38% opacity; the open panel fades only to ~78% opacity so the editor remains legible. Activity restores full opacity. The page being hidden also dims the widget. Reduced-motion preferences disable fade animation.

The widget's position and size apply to the current page session. They are not synced to your account or stored permanently.

## Launcher visibility and Saved Links

When you open the floating toolbelt, the draggable **O** launcher is hidden so it does not sit on top of or distract from the panel. The panel's **×** close button restores the launcher at its original position. The **Saved Links** tool in the bottom bar includes a prominent **Save page link →** button that saves the current website to the existing Saved Links collection; success or failure appears inside the panel.

## Shared launcher space, theme, and My Links

- **Launcher shares panel space:** when the toolbelt opens, the `O` is hidden **behind the panel in the same screen location**. The panel's bottom edge aligns with the launcher's bottom edge instead of reserving a separate 54-pixel gap, and you can drag the open panel toward the bottom of the viewport. The `×` button restores the launcher.
- **Match Oge appearance:** the widget uses Oge's light and dark palette. Open the **connected OgeNotes site** and change its theme; the extension watches the site's `data-theme` and securely updates the widget across tabs. The connection must be set up first. Other websites cannot change this theme; the extension defaults to Oge's dark theme until synchronized.
- **Save page link moved into My Links:** select **My links** to see GitHub, LinkedIn and portfolio URLs, followed by **Save current page to Saved Links**. The separate Saved Links tab is removed, leaving a reserved **Coming soon** slot for future features.

The toolbar popup still includes its original standalone **Save tab** action; only the **floating widget** layout changes in this update.

## One-click corner positioning

The floating panel header has a **⌖ Position** control. Each click moves the **open widget** clockwise through **top-right → bottom-right → bottom-left → top-left → top-right**. It keeps a small gap from the screen edge, preserves panel resizing, and updates the button's accessible label to show the next destination. If the viewport changes size, the selected corner is reapplied. Dragging the panel manually leaves corner-snap mode. Closing the widget brings the floating `O` launcher back at the panel's current corner.

## Learning Tracks preview (M97)

On an HTTPS YouTube playlist or a watch page with a playlist query, open the floating **O** and select **Tracks**. Enter your own track name, videos-per-day goal and optional total number of videos. The background worker takes the tab URL from Chrome (not from webpage messages), and posts only this metadata to a token-authenticated route. The feature is **default OFF** on the server (`OGE_LEARNING_TRACKS_PREVIEW=false`). It does not scrape playlists or transmit titles, transcripts, watch history or note bodies. View and manually advance tracks at `/learning-tracks` after enabling an isolated preview. No automatic lesson notes, GitHub note commits, notifications, or provider-backed playlist extraction are implemented yet. The server limits each owner to 100 tracks and validates the owner/token in a MongoDB transaction. Release still requires real Chrome and two-device staging tests.

## M109 — Editing while a Save is in flight

The extension uses the exact text and subject visible when **Save** is
pressed. If you continue typing while GitHub responds, the newer text
remains in the editor; the confirmation applies only to the earlier
submission. Press Save again for the newer text.

On connection failure or an unknown outcome, the extension leaves the note
in place and keeps the same capture ID for a retry with unchanged content.
Multiple Save clicks during the same request do not start multiple commits.
Test this in a real Chrome session with a connected GitHub Vault before
production use; automated tests exercise simulated network responses.

## M107 — shared GitHub Note capture

Connected users now open **Quick Notes** or **AirNotes** in the Oge website and
arrive at the shared GitHub-backed **Quick Capture** editor. The old standalone
screens and existing MongoDB APIs remain unchanged for unconnected accounts.
This applies to **new captures**; existing historical standalone notes are
**not migrated, deleted or copied** automatically.

The updated floating extension asks the server whether the account is Vault-
ready before enabling Save. When connected, its Save calls only the new Vault
endpoint and uses the same private GitHub Notes repository as the full editor.
If a response is lost, the widget retains the note and its original capture
UUID. Selecting Save again rechecks that exact Note ID to avoid duplicate
commits. The user must select an existing subject and supply title + body;
the extension deliberately does not create subjects.

Older builds that still call the legacy Quick Note API receive a clear
**update extension** message for connected Vault users instead of creating a
second permanent MongoDB Note. Loading failures never silently switch the
updated widget back to old storage.

**Live Chrome/GitHub testing still needed:** install the updated extension,
connect a token, choose a subject, Save, reload Oge, check the Note, and
simulate a lost Save response. CI alone does not prove that journey.
