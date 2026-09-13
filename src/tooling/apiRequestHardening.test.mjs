import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  admitApiRequest,
  apiOriginGatePlugin,
} from '../../server/standalone/api-origin-gate.js';
import { createDebugLogHandler } from '../../server/providers/openai/debug-log.js';

const HOST = 'localhost:4173';

test("the application's own requests and non-browser clients are admitted", () => {
  for (const request of [
    { fetchSite: 'same-origin', hostHeader: HOST },
    { fetchSite: 'SAME-ORIGIN', hostHeader: HOST },
    { fetchSite: 'none', hostHeader: HOST },
    {
      fetchSite: 'same-origin',
      origin: 'http://localhost:4173',
      hostHeader: HOST,
    },
    { origin: 'http://localhost:4173', hostHeader: HOST },
    { origin: 'http://127.0.0.1:4173', hostHeader: '127.0.0.1:4173' },
    { origin: 'http://[::1]:4173', hostHeader: '[::1]:4173' },
    { origin: 'http://example.test', hostHeader: 'EXAMPLE.test:80' },
    { hostHeader: HOST },
    {},
  ]) {
    assert.deepEqual(
      admitApiRequest(request),
      { ok: true },
      JSON.stringify(request),
    );
  }
});

test('requests from other sites are refused before they can spend anything', () => {
  for (const request of [
    { fetchSite: 'cross-site', hostHeader: HOST },
    { fetchSite: 'same-site', hostHeader: HOST },
    {
      fetchSite: 'cross-site',
      origin: 'http://localhost:4173',
      hostHeader: HOST,
    },
    { fetchSite: 'same-origin, cross-site', hostHeader: HOST },
    { fetchSite: ['same-origin', 'cross-site'], hostHeader: HOST },
    { origin: 'https://attacker.example', hostHeader: HOST },
    { origin: 'http://localhost:3000', hostHeader: HOST },
    { origin: 'null', hostHeader: HOST },
    { origin: 'file://', hostHeader: HOST },
    { origin: 'ws://localhost:4173', hostHeader: HOST },
    { origin: 'http://localhost:4173/path', hostHeader: HOST },
    { origin: 'http://user@localhost:4173', hostHeader: HOST },
    {
      origin: ['http://localhost:4173', 'https://attacker.example'],
      hostHeader: HOST,
    },
    { origin: 'http://localhost:4173' },
    { origin: 'http://localhost:4173', hostHeader: 'localhost:4173/evil' },
    {
      fetchSite: 'same-origin',
      origin: 'http://localhost:4173',
      hostHeader: 'localhost:4174',
    },
  ]) {
    assert.equal(admitApiRequest(request).ok, false, JSON.stringify(request));
  }
});

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook} mounts one /api gate that answers refusals itself`, () => {
    const routes = [];
    apiOriginGatePlugin()[hook]({
      middlewares: { use: (route, handler) => routes.push([route, handler]) },
    });
    assert.equal(routes.length, 1);
    const [route, gate] = routes[0];
    assert.equal(route, '/api');

    const run = (headers) => {
      let passed = false;
      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        writeHead(status, values) {
          this.statusCode = status;
          Object.assign(this.headers, values);
        },
        end(body = '') {
          this.body = String(body);
        },
      };
      gate({ headers }, res, () => {
        passed = true;
      });
      return { passed, res };
    };

    const own = run({ host: HOST, 'sec-fetch-site': 'same-origin' });
    assert.equal(own.passed, true);
    assert.equal(own.res.body, undefined);

    const hostile = run({ host: HOST, 'sec-fetch-site': 'cross-site' });
    assert.equal(hostile.passed, false);
    assert.equal(hostile.res.statusCode, 403);
    assert.equal(hostile.res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(JSON.parse(hostile.res.body), {
      error: 'Cross-site API requests are refused',
    });
  });
}

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { method: 'POST', headers: {} });
    const res = {
      statusCode: 200,
      setHeader() {},
      end() {
        resolve(this.statusCode);
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function logRoot(t) {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'gev-debug-log-'));
  t.after(() => rmSync(sourceRoot, { recursive: true, force: true }));
  return sourceRoot;
}

test('the voice debug log keeps at most two bounded generations', async (t) => {
  const sourceRoot = logRoot(t);
  const rotateBytes = 256;
  const handler = createDebugLogHandler({ sourceRoot, rotateBytes });
  const directory = path.join(sourceRoot, '.gev-logs');
  const current = path.join(directory, 'realtime-conversations.jsonl');
  const previous = path.join(directory, 'realtime-conversations.1.jsonl');
  const posts = 12;
  for (let index = 0; index < posts; index++) {
    const body = JSON.stringify({ index, padding: 'x'.repeat(60) });
    assert.equal(await post(handler, body), 204);
    assert.ok(statSync(current).size <= rotateBytes, `after post ${index}`);
  }
  assert.deepEqual(readdirSync(directory).sort(), [
    'realtime-conversations.1.jsonl',
    'realtime-conversations.jsonl',
  ]);
  assert.ok(statSync(previous).size <= rotateBytes);
  const indexes = (file) =>
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).index);
  const kept = [...indexes(previous), ...indexes(current)];
  assert.ok(kept.length >= 2);
  assert.deepEqual(
    kept,
    Array.from({ length: kept.length }, (_, i) => posts - kept.length + i),
  );
});

test('the voice debug log rotates at 16 MiB by default', async (t) => {
  const sourceRoot = logRoot(t);
  const handler = createDebugLogHandler({ sourceRoot });
  const directory = path.join(sourceRoot, '.gev-logs');
  const lineCount = (name) =>
    readFileSync(path.join(directory, name), 'utf8').trim().split('\n').length;
  const padding = 'x'.repeat(7 * 1024 * 1024);
  for (let index = 0; index < 2; index++) {
    assert.equal(await post(handler, JSON.stringify({ index, padding })), 204);
  }
  assert.deepEqual(readdirSync(directory), ['realtime-conversations.jsonl']);
  assert.equal(lineCount('realtime-conversations.jsonl'), 2);
  assert.equal(await post(handler, JSON.stringify({ index: 2, padding })), 204);
  assert.equal(lineCount('realtime-conversations.1.jsonl'), 2);
  assert.equal(lineCount('realtime-conversations.jsonl'), 1);
});
