// Watches SoundCloud's own outbound API traffic and lifts the two things we
// need to talk to api-v2 ourselves: the OAuth token and the client_id.
//
// This is observation only. onSendHeaders is non-blocking, which is why it is
// still available under MV3 without declarativeNetRequest gymnastics.

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const patch = {};

    const auth = (details.requestHeaders || []).find(
      (h) => h.name.toLowerCase() === 'authorization'
    );
    if (auth && auth.value && auth.value.startsWith('OAuth ')) {
      patch.token = auth.value;
    }

    try {
      const id = new URL(details.url).searchParams.get('client_id');
      if (id) patch.clientId = id;
    } catch (_) {}

    if (Object.keys(patch).length) {
      chrome.storage.session.set(patch);
    }
  },
  { urls: ['https://api-v2.soundcloud.com/*'] },
  ['requestHeaders']
);

// Clicking the toolbar icon opens the side panel rather than a popup, so
// playback survives the panel losing focus.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('[true shuffle] sidePanel', e));
