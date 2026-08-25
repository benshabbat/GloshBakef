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
  REVEAL_ALL: "reveal-all"
};

/** Sentinel score used when an image could not be fetched or decoded. */
export const UNKNOWN_SCORE = -1;
