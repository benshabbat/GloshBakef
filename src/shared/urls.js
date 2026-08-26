/**
 * Which URLs the extension is willing to fetch on its own behalf.
 *
 * Every URL the worker is asked about comes out of page markup, and the offscreen
 * document fetches with the extension's host permissions — so it is not subject to the
 * CORS and Private Network Access rules the page itself lives under. Without a filter
 * here, a hostile page could point an `<img>` at the user's router or at a service on
 * localhost and have the extension issue the request for it.
 *
 * A rejected URL is not dropped: the caller falls back to the pixel path, where the
 * source is the element the page already decoded and the extension issues no request at
 * all. So filtering costs no coverage — a `localhost` image the user is genuinely looking
 * at is still classified, just from its pixels.
 */

/** 0.0.0.0/8, 10/8, 127/8, 169.254/16 (link-local), 172.16/12 and 192.168/16. */
const PRIVATE_V4 = /^(?:0|10|127)\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\.|^192\.168\./;
const LOCAL_NAMES = /^(?:localhost|.+\.(?:localhost|local|internal|home\.arpa))$/;

/**
 * `data:` is allowed because it carries its own bytes — fetching one reaches no host and
 * tells no one anything. `blob:` is not: a page's blob URL only resolves inside that
 * page, so the extension could never fetch it anyway.
 */
export function isFetchableUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "data:") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !isPrivateHost(url.hostname);
}

/**
 * The URL parser has already canonicalised the host, so the decimal and hex spellings of
 * an IPv4 address (`http://2130706433/`) arrive here as dotted quads and are covered.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  if (!host) return true;
  if (LOCAL_NAMES.test(host) || PRIVATE_V4.test(host)) return true;
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    // ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local.
    return v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  return false;
}
