# OgeNotes floating study toolbelt

The Chrome Manifest V3 extension now combines the original OgeNotes floating Quick Notes feature with the new Oge tools:

- **Quick Note:** write while browsing; the first line becomes the title and content saves to the account's existing `quickNotes` collection.
- **Save URL:** save the current page in Saved Links.
- **My Links:** view the GitHub, LinkedIn and portfolio URLs saved in Profile, and copy or visit them.
- A draggable **O** button appears at the bottom right of regular HTTP and HTTPS pages. The existing extension popup remains available for token setup, saving tabs, and profile links.

## Install and connect

1. In Chrome, visit `chrome://extensions`, turn on Developer mode, and click **Load unpacked**. Select the `extension/` directory of the **oge** repository.
2. Sign in to your OgeNotes site and open **Browser Extension**. Generate an extension token.
3. Open the Chrome extension popup, choose **Connect**, paste the site origin (such as `http://localhost:3000` for local development) and the token, and click **Save connection**. Approve host permission.
4. **Reload existing website tabs** to inject the widget, click the floating **O** button, and use any of the three tools. The header can be dragged.
5. Find saved notes in **Quick Notes** and saved tabs in **Saved Links**. Add My Links in **Profile**.

## Security and limitations

- The content script never reads or receives the connection token. The extension's background service worker reads the token from `chrome.storage.local` and talks to token-authenticated OgeNotes APIs.
- The Quick Notes endpoint is write-only, scopes documents to the token owner, validates content length, rate limits writes, and rechecks token validity inside the account transaction.
- This feature adds Chrome host-page content-script access so the floating widget can be injected. Chrome may display an updated permission notice when the extension reloads.
- The floating widget is injected into the top document of ordinary HTTP/HTTPS websites, **not** browser-internal pages (`chrome://`), the Chrome Web Store, PDFs rendered in internal viewers, or sites where Chrome prevents injection.
- It intentionally does not scrape or transmit web-page content. Only text you enter and the URL of a page you explicitly save are sent.
- Browser behavior, keyboard shortcuts, connection revocation, and clipboard fallback require manual Chrome validation before deployment.
- To revoke access, use the Browser Extension page in OgeNotes; deleting the local token alone is not server-side revocation.

## Choose a subject when capturing

In the floating Quick Note editor, **Save to** defaults to **Quick Notes**. Select a subject from your existing Notes subjects to save there instead. The first line becomes the Notes heading, while the remaining text becomes the body. Subject notes require both a first-line heading and text below it. If no subject is selected, the original standalone Quick Notes behavior remains unchanged.

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
