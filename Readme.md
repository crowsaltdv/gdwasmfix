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

`index.html` is `index.svg` with its embedded page decoded and pointed at the local
server instead of the jsDelivr mirror and the third-party proxy; `index.svg` is
unchanged. Append `?debug` to the URL to show the game's log console.
