/**
 * Requests a browser may send to `/api` on behalf of this application's pages:
 * `same-origin` (the app's own fetch, beacon, image and video requests) and
 * `none` (a URL the user typed or bookmarked). `same-site` is refused too — it
 * is what another app on a different localhost port produces.
 */
const ADMITTED_FETCH_SITES = new Set(['same-origin', 'none']);

/** One header as a string; repeated values arrive comma-joined and match nothing. */
function headerValue(value) {
  return String(value ?? '').trim();
}

/** Host and port a request was addressed to, normalized like an Origin's. */
function requestAuthority(hostHeader, protocol) {
  const raw = headerValue(hostHeader);
  if (/[\s/?#@\\]/.test(raw)) return null;
  try {
    return new URL(`${protocol}//${raw}`).host;
  } catch {
    return null;
  }
}

/**
 * Decide whether one `/api` request came from this application's own origin.
 *
 * Every route under `/api` spends a server-side credential, writes to disk, or
 * both. A page on any other site can make the user's browser send a simple GET
 * or text/plain POST to this server without a CORS preflight: the response
 * stays unreadable, but the cost is already incurred. Browsers label such
 * requests with `Sec-Fetch-Site`, and an `Origin` header, when sent, must name
 * the host the request was addressed to. A request carrying neither header
 * comes from a non-browser client (curl, local tooling), which a web page
 * cannot impersonate, and is admitted. Host validation itself stays with
 * Vite's `allowedHosts`, which runs before plugin middleware.
 *
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function admitApiRequest({ fetchSite, origin, hostHeader } = {}) {
  const site = headerValue(fetchSite).toLowerCase();
  if (site !== '' && !ADMITTED_FETCH_SITES.has(site)) {
    return { ok: false, error: 'Cross-site API requests are refused' };
  }
  const originValue = headerValue(origin);
  if (originValue === '') return { ok: true };
  let parsed;
  try {
    parsed = new URL(originValue);
  } catch {
    return { ok: false, error: 'Unrecognized Origin refused' };
  }
  // An Origin header is exactly scheme://host[:port]; anything else (`null`,
  // a path, credentials) is not one this application's pages send.
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== originValue.toLowerCase()
  ) {
    return { ok: false, error: 'Unrecognized Origin refused' };
  }
  if (parsed.host !== requestAuthority(hostHeader, parsed.protocol)) {
    return { ok: false, error: 'Cross-origin API requests are refused' };
  }
  return { ok: true };
}

/** Refuse other sites' requests before any `/api` provider runs. Install first. */
export function apiOriginGatePlugin() {
  const install = (server) => {
    server.middlewares.use('/api', (req, res, next) => {
      const decision = admitApiRequest({
        fetchSite: req.headers['sec-fetch-site'],
        origin: req.headers.origin,
        hostHeader: req.headers.host,
      });
      if (decision.ok) {
        next();
        return;
      }
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: decision.error }));
    });
  };
  return {
    name: 'api-origin-gate',
    configureServer: install,
    configurePreviewServer: install,
  };
}
