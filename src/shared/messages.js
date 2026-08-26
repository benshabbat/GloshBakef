/** Message names shared by the content script, the service worker and the offscreen document. */
export const MSG = {
  /**
   * content script -> worker: score one image URL, optionally with pixels attached.
   * `cache: false` opts a payload out of the URL cache — video frames use it, since the
   * picture behind a video URL is different every time it is sampled.
   */
  SCORE: "score-image",
  /** worker -> offscreen document: run the model. */
  SCORE_OFFSCREEN: "score-image-offscreen",
  /** content script -> worker: report how many images this frame is hiding. */
  REPORT: "report-blocked",
  /** popup -> worker: what is happening in the active tab? */
  TAB_STATE: "tab-state",
  /** popup -> content script: reveal everything on the page. */
  REVEAL_ALL: "reveal-all",
  /**
   * options page -> worker: walk the whole analysis chain on a built-in test image and
   * report where it stops. Exists because every failure in that chain fails open, which
   * makes a broken pipeline and a clean page look identical from the outside.
   */
  SELFTEST: "self-test"
};

/** Sentinel score used when an image could not be fetched or decoded. */
export const UNKNOWN_SCORE = -1;

/**
 * Did this message come from one of the extension's own pages — the popup or the options
 * page — rather than from a content script?
 *
 * `sender.tab` cannot answer that, and reaching for it is the trap. It is set for anything
 * sent from a tab, which covers content scripts *and* the options page, so `if (sender.tab)`
 * rejects a legitimate caller. Only the popup happens to have no tab, which makes the
 * mistake invisible until an options-page message is added.
 *
 * `sender.url` is the honest signal: a content script reports the URL of the page it was
 * injected into, never a `chrome-extension://` one, no matter who the page claims to be.
 */
export function isFromExtensionPage(sender, extensionOrigin) {
  if (!extensionOrigin) return false;
  return Boolean(sender?.url?.startsWith(extensionOrigin));
}
