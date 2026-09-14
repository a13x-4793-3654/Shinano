import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureRequest {
  path: string;
  method: string;
  body: string;
  referrer: string;
}

export const literalDownloadName = '&lt;img src=x onerror=fixtureXss=1&gt;.txt';

function htmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

export async function startFixture() {
  const requests: FixtureRequest[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (body.length > 4096) {
        response.writeHead(413).end();
        return;
      }
    }
    requests.push({ path: url.pathname, method: request.method ?? 'GET', body, referrer: request.headers.referer ?? '' });
    if (url.pathname === '/download' || url.pathname === '/download-literal') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': url.pathname === '/download-literal'
          ? `attachment; filename*=UTF-8''${encodeURIComponent(literalDownloadName)}`
          : 'attachment; filename="shinano-fixture.txt"',
      }).end('Local Shinano fixture. No credentials.');
      return;
    }
    if (url.pathname === '/redirect-external') {
      response.writeHead(302, { Location: 'msteams://fixture-unsupported' }).end();
      return;
    }
    if (url.pathname === '/redirect') {
      const target = url.searchParams.get('target');
      if (!target || !/^http:\/\/127\.0\.0\.1:\d+\/fixture-redirected$/.test(target)) {
        response.writeHead(400).end('Only the local fixture redirect is allowed.');
        return;
      }
      response.writeHead(302, { Location: target }).end();
      return;
    }
    if (url.pathname === '/network-error') {
      response.destroy();
      return;
    }
    if (url.pathname === '/slow') {
      // Keep the response uncommitted until the client cancels it.
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture ${htmlEscape(url.pathname)}</title></head>
      <body><h1>Local Shinano fixture</h1>
        <p id="path">${htmlEscape(url.pathname)}</p><p id="method">${request.method}</p><p id="body">${htmlEscape(body)}</p>
        <a id="blank-link" href="/linked" target="_blank">New tab link</a>
        <a id="background-link" href="/background">Background tab link</a>
        <a id="download-link" href="/download">Download fixture</a>
        <form id="post-form" action="/post" method="post" target="_blank"><input name="sample" value="local-fixture"><button>POST</button></form>
        <script>
          window.fixtureMessages = [];
          window.addEventListener('message', event => {
            window.fixtureMessages.push({ data: event.data, origin: event.origin });
          });
          window.fixtureRead = () => ({
            cookie: document.cookie,
            local: localStorage.getItem('fixture-role'),
            session: sessionStorage.getItem('fixture-tab')
          });
          window.fixtureWrite = value => {
            document.cookie = 'shinano_fixture=' + encodeURIComponent(value) + '; Path=/; Max-Age=86400; SameSite=Lax';
            localStorage.setItem('fixture-role', value);
          };
          window.fixtureDatabase = (value) => new Promise((resolve, reject) => {
            const open = indexedDB.open('shinano-fixture', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('values');
            open.onerror = () => reject(new Error('Fixture database failed'));
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction('values', value === undefined ? 'readonly' : 'readwrite');
              const store = tx.objectStore('values');
              const operation = value === undefined ? store.get('role') : store.put(value, 'role');
              let result;
              operation.onsuccess = () => { result = operation.result ?? null; };
              tx.oncomplete = () => { db.close(); resolve(result); };
              tx.onerror = () => { db.close(); reject(new Error('Fixture transaction failed')); };
            };
          });
          if (location.pathname === '/') document.title = 'Restored ' + (localStorage.getItem('fixture-role') || 'empty');
          if (location.pathname === '/auth-popup') {
            const target = new URLSearchParams(location.search).get('target') || location.origin;
            if (window.opener) window.opener.postMessage('fixture-auth-complete', target);
            window.close();
          }
        </script>
      </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
