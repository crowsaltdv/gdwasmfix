all credits go to bog @ truffled (truffled.lol) 

## Running locally

Requires [Node.js](https://nodejs.org/) 18 or newer (no packages to install).

```
node server.js          # http://localhost:8080/
node server.js 3000     # or pick another port (PORT / HOST env vars also work)
```

Open the printed address and click "load". The first load reads ~390 MB of
`gd_web.*` chunks from this folder, so give it a minute.

`server.js` serves `index.html` and the chunks, and implements `/__proxy?url=...`,
the endpoint the game uses for everything online (level search/download, accounts,
custom songs). It forwards those requests to boomlings.com and the song hosts
without a User-Agent, which boomlings.com requires, and refuses private/loopback
addresses. It listens on 127.0.0.1 only, unless `HOST` is set or a hosting
platform provides `PORT` (then it listens on 0.0.0.0).

## Hosting (Render)

Web Service, Node runtime: Build Command `yarn`, Start Command `node server.js`
(`package.json` has no dependencies, so `yarn` is a no-op). Render supplies `PORT`.

**Online levels need a relay when hosted.** boomlings.com bans the IP ranges of most
hosting providers: the proxy gets `error code: 1005` back and the game shows empty
lists and endless spinners. It does accept requests coming from Cloudflare Workers:

1. Cloudflare dashboard -> Workers & Pages -> Create -> Worker -> Deploy, then
   Edit code, paste [worker.js](worker.js) over the sample and Deploy again. Note the
   `https://<name>.<account>.workers.dev` address.
2. Recommended: in the worker's Settings -> Variables and Secrets add a secret named
   `PROXY_KEY` (any long random string) so only your server can use the relay.
3. In Render -> Environment set `UPSTREAM_PROXY` to
   `https://<name>.<account>.workers.dev/?url=` and, if you set a key,
   `UPSTREAM_PROXY_KEY` to the same string. Render redeploys on save.
4. Check the worker: this should print level data (`1:...`), not HTML or `error code`:

   ```
   curl -X POST -H "x-proxy-key: YOUR_KEY" -d "type=0&page=0&secret=Wmfd2893gb7" "https://<name>.<account>.workers.dev/?url=https://www.boomlings.com/database/getGJLevels21.php"
   ```

The worker only relays to boomlings.com, newgrounds/ngfiles, b-cdn.net and robtopgames.com.
Players' game traffic (including logins) passes through your worker, so deploy your own
rather than using someone else's.

`index.html` is `index.svg` with its embedded page decoded and pointed at the local
server instead of the jsDelivr mirror and the third-party proxy; `index.svg` is
unchanged. Append `?debug` to the URL to show the game's log console.
