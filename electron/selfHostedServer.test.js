import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  SELF_HOSTED_SERVER_ENV_KEY,
  SELF_HOSTED_SERVER_FILE_NAME,
  normalizeServerUrl,
  probeSelfHostedServer,
  resolveSelfHostedServer,
} from './selfHostedServer.js';

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

describe('normalizeServerUrl', () => {
  it('keeps only the origin of an http(s) URL of a site root', () => {
    assert.equal(normalizeServerUrl('https://cloudcli.example.com/'), 'https://cloudcli.example.com');
    assert.equal(normalizeServerUrl('  https://cloudcli.example.com:8443/?x=1#y '), 'https://cloudcli.example.com:8443');
    assert.equal(normalizeServerUrl('http://192.168.1.5:3001'), 'http://192.168.1.5:3001');
  });

  it('rejects anything that is not an http(s) URL of a site root', () => {
    for (const value of ['', '   ', 'cloudcli.example.com', 'ftp://example.com', 'file:///etc/passwd', 'https://example.com/cloudcli', null, 42]) {
      assert.equal(normalizeServerUrl(value), null, `value ${JSON.stringify(value)}`);
    }
  });
});

describe('resolveSelfHostedServer', () => {
  let root;
  let userDataPath;
  let appRoot;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-self-hosted-'));
    userDataPath = path.join(root, 'userData');
    appRoot = path.join(root, 'app');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns null when nothing is configured', async () => {
    assert.equal(await resolveSelfHostedServer({ env: {}, userDataPath, appRoot }), null);
  });

  it('uses the file bundled into the app', async () => {
    const bundled = path.join(appRoot, 'electron', SELF_HOSTED_SERVER_FILE_NAME);
    await writeJson(bundled, { url: 'https://bundled.example.com/' });
    assert.deepEqual(await resolveSelfHostedServer({ env: {}, userDataPath, appRoot }), {
      url: 'https://bundled.example.com',
      name: 'bundled.example.com',
      source: bundled,
    });
  });

  it('lets the user file override the bundled one, and the environment override both', async () => {
    await writeJson(path.join(appRoot, 'electron', SELF_HOSTED_SERVER_FILE_NAME), { url: 'https://bundled.example.com' });
    const userFile = path.join(userDataPath, SELF_HOSTED_SERVER_FILE_NAME);
    await writeJson(userFile, { url: 'https://user.example.com:8443' });

    const fromUser = await resolveSelfHostedServer({ env: {}, userDataPath, appRoot });
    assert.equal(fromUser.url, 'https://user.example.com:8443');
    assert.equal(fromUser.name, 'user.example.com:8443');
    assert.equal(fromUser.source, userFile);

    const fromEnv = await resolveSelfHostedServer({
      env: { [SELF_HOSTED_SERVER_ENV_KEY]: 'https://env.example.com' },
      userDataPath,
      appRoot,
    });
    assert.deepEqual(fromEnv, { url: 'https://env.example.com', name: 'env.example.com', source: SELF_HOSTED_SERVER_ENV_KEY });
  });

  it('fails loudly on a malformed value instead of falling back to another server', async () => {
    await writeJson(path.join(appRoot, 'electron', SELF_HOSTED_SERVER_FILE_NAME), { url: 'https://bundled.example.com' });

    await writeJson(path.join(userDataPath, SELF_HOSTED_SERVER_FILE_NAME), '{not json');
    await assert.rejects(resolveSelfHostedServer({ env: {}, userDataPath, appRoot }), /not valid JSON/);

    await writeJson(path.join(userDataPath, SELF_HOSTED_SERVER_FILE_NAME), { url: 'cloudcli.example.com' });
    await assert.rejects(resolveSelfHostedServer({ env: {}, userDataPath, appRoot }), /must contain/);

    await assert.rejects(
      resolveSelfHostedServer({ env: { [SELF_HOSTED_SERVER_ENV_KEY]: 'not a url' }, userDataPath, appRoot }),
      /must be an http\(s\) URL/,
    );
  });
});

describe('probeSelfHostedServer', () => {
  let server;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  it('accepts a server that answers like CloudCLI', async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/health' ? { status: 'ok', installMode: 'npm' } : {}));
    });
    const port = await listen(server);
    assert.equal(await probeSelfHostedServer(`http://127.0.0.1:${port}`, 2000), true);
  });

  it('rejects a server that answers something else', async () => {
    server = http.createServer((_req, res) => res.end('<html>not cloudcli</html>'));
    const port = await listen(server);
    assert.equal(await probeSelfHostedServer(`http://127.0.0.1:${port}`, 2000), false);
  });

  it('gives up on a server that keeps a response open by trickling bytes', async () => {
    // http.get's `timeout` only fires after the socket has been idle; a server
    // that sends a byte every 200 ms is never idle, so without an overall
    // deadline the probe (and every open waiting on it) never settles.
    const timers = new Set();
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const timer = setInterval(() => res.write(' '), 200);
      timers.add(timer);
      res.on('close', () => clearInterval(timer));
    });
    const port = await listen(server);
    const startedAt = Date.now();
    try {
      assert.equal(await probeSelfHostedServer(`http://127.0.0.1:${port}`, 1000), false);
      assert.ok(Date.now() - startedAt < 3000, `probe took ${Date.now() - startedAt} ms`);
    } finally {
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections();
    }
  });

  it('reports an unreachable https server as unreachable instead of throwing', async () => {
    // Before the fix the probe used http.get for every URL and threw
    // ERR_INVALID_PROTOCOL on https, which aborted server discovery.
    const port = await closedPort();
    assert.equal(await probeSelfHostedServer(`https://127.0.0.1:${port}`, 2000), false);
  });
});
