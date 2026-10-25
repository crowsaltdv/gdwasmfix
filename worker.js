// Cloudflare Worker that relays Geometry Dash requests to boomlings.com and the song hosts.
//
// boomlings.com rejects the IP ranges of most hosting providers ("error code: 1005") and any
// request that carries a User-Agent, but accepts requests coming from Cloudflare's own network.
// server.js calls this worker when UPSTREAM_PROXY points at it (see Readme.md).
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> Start with Hello World -> Deploy,
// then Edit code, paste this file over the sample and Deploy again.
// Optional: Settings -> Variables and Secrets -> add a secret named PROXY_KEY and give the same
// value to the server as UPSTREAM_PROXY_KEY, so only your server can use this relay.

const ALLOWED_HOSTS = ['boomlings.com', 'ngfiles.com', 'newgrounds.com', 'b-cdn.net', 'robtopgames.com'];

function hostAllowed(hostname) {
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
}

export default {
  async fetch(request, env) {
    if (env.PROXY_KEY && request.headers.get('x-proxy-key') !== env.PROXY_KEY) {
      return new Response('Forbidden', { status: 403 });
    }
    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let target;
    try {
      target = new URL(new URL(request.url).searchParams.get('url'));
    } catch (e) {
      return new Response('Missing or invalid ?url=', { status: 400 });
    }
    if ((target.protocol !== 'https:' && target.protocol !== 'http:') || !hostAllowed(target.hostname)) {
      return new Response('Target not allowed', { status: 403 });
    }
    // boomlings.com answers plain http with a redirect that drops the POST body.
    if (target.hostname === 'boomlings.com' || target.hostname.endsWith('.boomlings.com')) {
      target.protocol = 'https:';
    }

    const headers = new Headers({ Accept: '*/*' });
    const type = request.headers.get('content-type');
    if (type) headers.set('Content-Type', type);
    const range = request.headers.get('range');
    if (range) headers.set('Range', range);
    // Empty on purpose: boomlings.com serves a challenge page to any non-empty User-Agent.
    headers.set('User-Agent', '');

    const upstream = await fetch(target.href, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
      redirect: 'follow',
    });

    const out = new Headers({ 'Cache-Control': 'no-store' });
    for (const h of ['content-type', 'content-range', 'accept-ranges', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
  },
};
