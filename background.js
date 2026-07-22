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

// Some tracks have no stream the anonymous embed is allowed to fetch (they
// need the user's auth, which the site has but the widget does not). The
// widget's hls/progressive stream request 404s and the player then silently
// hangs with no ERROR event. We watch for that failure and tell the panel which
// track it was, so the panel can skip it fast instead of waiting out its stall
// timeout. The track id is in the request URL as "tracks:<id>".
function reportStreamFail(details) {
  if (typeof details.statusCode === 'number' && details.statusCode < 400) return;
  const m = /tracks:(\d+)/.exec(details.url);
  if (!m) return;
  chrome.runtime
    .sendMessage({ type: 'stream-fail', trackId: Number(m[1]) })
    .catch(() => {}); // panel may be closed; nothing to do
}

const STREAM_FILTER = { urls: ['https://api-widget.soundcloud.com/media/*/stream/*'] };
chrome.webRequest.onCompleted.addListener(reportStreamFail, STREAM_FILTER);
chrome.webRequest.onErrorOccurred.addListener(reportStreamFail, STREAM_FILTER);

// Clicking the toolbar icon opens the side panel rather than a popup, so
// playback survives the panel losing focus.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('[true shuffle] sidePanel', e));
