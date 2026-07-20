# SoundCloud True Shuffle

A Chrome extension that shuffles your **entire** liked-tracks library, not just
the handful of tracks the likes page happens to have loaded.

## Why

SoundCloud's built-in shuffle only randomizes the tracks the likes page has
lazily rendered into the DOM. For a large library that is roughly the first
page, in near-identical order every time, so pressing shuffle gives you the same
few dozen tracks on repeat. This extension bypasses the page and talks to
SoundCloud's internal `api-v2` directly, so the sample space is every track you
have ever liked.

It runs in a side panel styled like a mobile music player, with an animated
"hexdump" ASCII backdrop rendered from the current track's artwork.

<!-- Add a screenshot at docs/screenshot.png and uncomment the next line:
![True Shuffle side panel](docs/screenshot.png)
-->

## Install

This is an unpacked extension. There is no build step and no Chrome Web Store
listing (see [Why it is not on the Web Store](#why-it-is-not-on-the-web-store)).

1. **Get the code.** Clone, or download the ZIP from GitHub and unzip it.

   ```
   git clone https://github.com/ben-thomas20/Soundcloud_Shuffle.git
   cd Soundcloud_Shuffle
   ```

2. **Fetch the SoundCloud Widget API.** It is third-party code and is not
   redistributed in this repo, so grab it into `vendor/`:

   ```
   mkdir -p vendor && curl -o vendor/sc-widget-api.js https://w.soundcloud.com/player/api.js
   ```

3. **Load it into Chrome.** Go to `chrome://extensions`, turn on **Developer
   mode** (top right), click **Load unpacked**, and select this folder.

4. **Capture your session.** Open `soundcloud.com` in a tab and let it load. The
   extension needs to observe one of SoundCloud's own API requests to pick up
   your session token (nothing is entered by hand).

5. **Shuffle.** Click the extension icon to open the side panel, then hit
   **reshuffle**. The first run pages through your whole library and caches it;
   later runs start instantly.

## How it works

- `background.js` watches `api-v2.soundcloud.com` requests via
  `webRequest.onSendHeaders` and stashes the `Authorization` token and
  `client_id` in `chrome.storage.session` (memory only, cleared on browser
  restart).
- `sidepanel.js` pages through your `track_likes` until there are no more,
  trims each track to five fields, caches the list in `chrome.storage.local`
  for 24 hours, then Fisher-Yates shuffles it and plays through an embedded
  widget with auto-advance.
- Tracks that load but never actually start (Go+, geo-blocked, embedding
  disabled) are timed out after 9 seconds and remembered in a persistent "dead
  list" so they are skipped on later runs.
- `ascii-bg.js` samples the current track's artwork into a grid and renders it
  as animated hex glyphs behind the player.

## Privacy and security

This extension reads your own SoundCloud OAuth token, locally, so it can call
the same API your browser already calls. That token stays on your machine in
session storage and **nothing is ever sent anywhere except SoundCloud's own
servers**. There is no analytics, no external server, and no third-party code
beyond the SoundCloud Widget API you fetch in step 2.

Because the extension reads an `Authorization` header to do this, treat it like
what it is: a personal tool you are running on your own account. Review the
source before loading it. It is deliberately small (a few plain files, no
bundler, no dependencies) so that it is easy to read end to end.

## Known limitations

- **Unplayable tracks.** Go+ subscription tracks, region-blocked uploads, and
  tracks with embedding disabled cannot play in the widget. They are detected,
  skipped, and remembered.
- **Closing the panel stops playback.** That is the tradeoff for using a side
  panel instead of a popup (a popup would stop the music every time it lost
  focus).
- **Token rotation.** If you start seeing "token expired," your OAuth token
  rotated. Reload `soundcloud.com` and it is picked up again.
- **api-v2 is undocumented.** These endpoints are unsupported and can change
  without notice.

## Why it is not on the Web Store

Capturing the session token requires reading the `Authorization` header off
SoundCloud's own traffic. That is structurally identical to how a credential
stealer would behave, so it would draw heavy review scrutiny and is not a good
fit for the Web Store. It is built for unpacked, personal use, which is why the
install is a load-unpacked flow rather than a one-click install.

## License

MIT, see [LICENSE](LICENSE). The license covers this repository's own code only;
the SoundCloud Widget API fetched at setup time is not included or relicensed.
