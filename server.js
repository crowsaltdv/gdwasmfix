#!/usr/bin/env node
'use strict';

// Local web server for the Geometry Dash WASM build.
//
//   node server.js [port]        (PORT / HOST env vars also work)
//
// It does two things:
//   1. Serves the static site (index.html, the gd_web.* chunks, ref/ images).
//   2. Implements /__proxy?url=<target>, the endpoint the game's libcurl shim
//      calls for every network request (online levels, accounts, songs). The
//      browser cannot talk to boomlings.com directly (no CORS headers), and
//      boomlings.com rejects requests that carry a browser User-Agent, so the
//      request is forwarded from here without one, like the real game does.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT) || 8080;
// Hosting platforms (Render, Railway, ...) set PORT and need the server reachable from outside.
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

const PROXY_PREFIX = '/__proxy?url=';
const MAX_BODY = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 30000;

// boomlings.com bans most hosting-provider IP ranges (Render answers "error code: 1005"),
// but lets Cloudflare Workers through. Set UPSTREAM_PROXY to a deployed worker.js, e.g.
// https://gd-relay.you.workers.dev/?url=  and every proxied request is relayed through it.
// UPSTREAM_PROXY_KEY is sent as X-Proxy-Key and must match the worker's PROXY_KEY secret.
const UPSTREAM_PROXY = relayBase(process.env.UPSTREAM_PROXY || '');
const UPSTREAM_PROXY_KEY = process.env.UPSTREAM_PROXY_KEY || '';

// Accepts https://x.workers.dev, https://x.workers.dev/ or https://x.workers.dev/?url= alike;
// the worker reads the target from the "url" query parameter.
function relayBase(value) {
  value = value.trim();
  if (!value) return '';
  return value.includes('?') ? value : value.replace(/\/*$/, '/') + '?url=';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

// ---------------------------------------------------------------- static files

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');

  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    return sendText(res, 400, 'Bad Request');
  }
  if (rel === '/') rel = '/index.html';

  const file = path.join(ROOT, path.normalize(rel));
  const inside = file === ROOT || file.startsWith(ROOT + path.sep);
  const hidden = path.relative(ROOT, file).split(path.sep).some((p) => p.startsWith('.'));
  if (!inside || hidden || path.basename(file) === 'server.js') return sendText(res, 404, 'Not Found');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not Found');

    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': /\.part\d+$|^\/ref\//.test(rel) ? 'public, max-age=3600' : 'no-cache',
    };

    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      } else {
        start = Math.max(0, st.size - Number(m[2]));
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    headers['Content-Length'] = end - start + 1;

    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

// ----------------------------------------------------------------------- proxy

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v);
}

// Resolves like dns.lookup, but refuses private/loopback addresses so the proxy
// cannot be pointed at services on this machine or the local network.
function publicLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some((a) => isPrivateAddress(a.address))) {
      return cb(new Error('refusing to connect to a private address'));
    }
    cb(null, address, family);
  });
}

function parseTarget(req) {
  let raw = req.url.slice(PROXY_PREFIX.length);
  if (/^https?%3a/i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch (e) { return null; }
  }
  let url;
  try { url = new URL(raw); } catch (e) { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // boomlings.com answers plain http with a redirect that drops the POST body.
  if (/(^|\.)boomlings\.com$/i.test(url.hostname)) url.protocol = 'https:';
  return url;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Node only calls `lookup` for hostnames, so IP literals are checked separately.
function isPrivateLiteral(url) {
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  return net.isIP(literal) !== 0 && isPrivateAddress(literal);
}

// `guarded` keeps the connection away from private addresses; it is off only for the
// operator-configured UPSTREAM_PROXY hop.
function upstream(url, method, headers, body, hop, guarded, onResponse, onError) {
  if (guarded && isPrivateLiteral(url)) {
    return onError(new Error('refusing to connect to a private address'));
  }
  const lib = url.protocol === 'https:' ? https : http;
  const options = guarded ? { method, headers, lookup: publicLookup } : { method, headers };
  const up = lib.request(url, options, (ures) => {
    const code = ures.statusCode;
    const loc = ures.headers.location;
    if (code >= 300 && code < 400 && loc && hop < MAX_REDIRECTS) {
      ures.resume();
      const next = new URL(loc, url);
      const keep = code === 307 || code === 308;
      const nextHeaders = Object.assign({}, headers);
      if (!keep) {
        delete nextHeaders['content-type'];
        delete nextHeaders['content-length'];
      }
      return upstream(next, keep ? method : 'GET', nextHeaders, keep ? body : null, hop + 1, guarded, onResponse, onError);
    }
    onResponse(ures);
  });
  up.setTimeout(UPSTREAM_TIMEOUT_MS, () => up.destroy(new Error('upstream timed out')));
  up.on('error', onError);
  if (body && body.length) up.write(body);
  up.end();
}

async function handleProxy(req, res) {
  const started = Date.now();
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method Not Allowed');
  }
  const target = parseTarget(req);
  if (!target) return sendText(res, 400, 'Bad proxy target');

  let body = null;
  try {
    body = req.method === 'POST' ? await readBody(req) : null;
  } catch (e) {
    return sendText(res, e.status || 400, e.message);
  }

  // No User-Agent on purpose: boomlings.com serves a Cloudflare challenge page to browsers.
  const headers = { Accept: '*/*', 'Accept-Encoding': 'identity' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (body) headers['content-length'] = body.length;
  if (req.headers.range) headers.range = req.headers.range;

  // With a relay configured the worker makes the real request, so the target is only
  // screened here (its own private-address checks can't run on a connection we don't make).
  let first = target;
  let guarded = true;
  if (UPSTREAM_PROXY) {
    if (isPrivateLiteral(target)) return sendText(res, 502, 'Proxy error: refusing to connect to a private address');
    try {
      first = new URL(UPSTREAM_PROXY + encodeURIComponent(target.href));
    } catch (e) {
      return sendText(res, 500, 'UPSTREAM_PROXY is not a valid URL');
    }
    guarded = false;
    if (UPSTREAM_PROXY_KEY) headers['x-proxy-key'] = UPSTREAM_PROXY_KEY;
  }

  const label = req.method + ' ' + target.hostname + target.pathname + (UPSTREAM_PROXY ? ' (relay)' : '');
  let replied = false;
  const fail = (err) => {
    console.log('[proxy] ' + label + ' failed: ' + err.message + ' (' + (Date.now() - started) + 'ms)');
    if (replied) return res.destroy();
    replied = true;
    sendText(res, 502, 'Proxy error: ' + err.message);
  };

  upstream(first, req.method, headers, body, 0, guarded, (ures) => {
    replied = true;
    const out = { 'Cache-Control': 'no-store' };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
      if (ures.headers[h]) out[h] = ures.headers[h];
    }
    res.writeHead(ures.statusCode, out);
    console.log('[proxy] ' + label + ' -> ' + ures.statusCode + ' (' + (Date.now() - started) + 'ms)');
    if (req.method === 'HEAD') { ures.resume(); return res.end(); }
    ures.on('error', () => res.destroy());
    ures.pipe(res);
  }, fail);
}

// ---------------------------------------------------------------------- server

const server = http.createServer((req, res) => {
  if (req.url.startsWith(PROXY_PREFIX)) {
    handleProxy(req, res).catch((e) => {
      console.log('[proxy] unexpected error: ' + (e && e.stack || e));
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
      else res.destroy();
    });
    return;
  }
  serveStatic(req, res);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('Port ' + PORT + ' is already in use. Try: node server.js ' + (PORT + 1));
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('Geometry Dash server running at http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + '/');
  console.log('Proxy for online levels: ' + PROXY_PREFIX + '<url>   (Ctrl+C to stop)');
  console.log(UPSTREAM_PROXY ? 'Relaying proxied requests through ' + UPSTREAM_PROXY + '<target>'
                             : 'Proxied requests go directly to the target hosts (no UPSTREAM_PROXY set).');
});
