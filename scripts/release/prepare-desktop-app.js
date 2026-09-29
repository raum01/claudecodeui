#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = path.join(rootDir, '.desktop-build', 'desktop-app');
// Build-time default for the self-hosted server the app opens
// (electron/selfHostedServer.js). Unset means the app has none built in.
const BUNDLED_SERVER_URL_ENV_KEY = 'CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL';
const SELF_HOSTED_SERVER_FILE = path.join('electron', 'self-hosted-server.json');

const packageJson = JSON.parse(
  await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'),
);

function getElectronVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ).version;
  } catch {
    try {
      return JSON.parse(
        readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
      ).packages['node_modules/electron'].version;
    } catch {
      throw new Error('Could not resolve an exact Electron version for desktop packaging.');
    }
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyRequired(relativePath) {
  const from = path.join(rootDir, relativePath);
  const to = path.join(stageDir, relativePath);
  if (!(await pathExists(from))) {
    throw new Error(`Required desktop build input is missing: ${relativePath}`);
  }
  await fs.cp(from, to, { recursive: true });
}

async function copyIfExists(relativePath) {
  const from = path.join(rootDir, relativePath);
  if (!(await pathExists(from))) return false;
  await fs.cp(from, path.join(stageDir, relativePath), { recursive: true });
  return true;
}

async function copyNodeModule(packageName) {
  const parts = packageName.split('/');
  const source = path.join(rootDir, 'node_modules', ...parts);
  if (!(await pathExists(source))) return false;

  const target = path.join(stageDir, 'node_modules', ...parts);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  return true;
}

// Unit tests live beside the Electron sources; they have no place in the app.
async function removeTestFiles(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await removeTestFiles(entryPath);
    } else if (/\.test\.[cm]?js$/.test(entry.name)) {
      await fs.rm(entryPath);
    }
  }
}

function normalizeServerOrigin(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${BUNDLED_SERVER_URL_ENV_KEY} is not a URL: ${JSON.stringify(rawUrl)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${BUNDLED_SERVER_URL_ENV_KEY} must be http(s): ${JSON.stringify(rawUrl)}`);
  }
  if (parsed.pathname !== '/') {
    throw new Error(`${BUNDLED_SERVER_URL_ENV_KEY} must be a site root with no path: ${JSON.stringify(rawUrl)}`);
  }
  return parsed.origin;
}

// The staged file is always derived from the environment, never copied from a
// developer's working tree, so a build cannot silently inherit someone's server.
async function writeBundledServerConfig() {
  const target = path.join(stageDir, SELF_HOSTED_SERVER_FILE);
  await fs.rm(target, { force: true });
  const rawUrl = process.env[BUNDLED_SERVER_URL_ENV_KEY];
  if (!rawUrl || !rawUrl.trim()) return;
  const url = normalizeServerOrigin(rawUrl.trim());
  await fs.writeFile(target, `${JSON.stringify({ url }, null, 2)}\n`, 'utf8');
  console.log(`Bundled self-hosted server: ${url}`);
}

function buildDesktopPackageJson(copiedOptionalDependencies) {
  return {
    name: `${packageJson.name}-desktop`,
    version: packageJson.version,
    productName: packageJson.productName,
    description: `${packageJson.productName} desktop shell`,
    author: packageJson.author,
    license: packageJson.license,
    type: 'module',
    main: 'electron/main.js',
    dependencies: {
      ws: packageJson.dependencies.ws,
    },
    optionalDependencies: copiedOptionalDependencies,
    build: {
      appId: packageJson.build.appId,
      productName: packageJson.build.productName,
      asar: packageJson.build.asar,
      artifactName: packageJson.build.artifactName,
      electronVersion: getElectronVersion(),
      directories: {
        output: '../../release/desktop',
      },
      extraMetadata: {
        main: 'electron/main.js',
      },
      files: [
        'electron/**',
        'public/**',
        'dist/**',
        'dist-server/**',
        'node_modules/**',
        'package.json',
      ],
      protocols: packageJson.build.protocols,
      mac: packageJson.build.mac,
      win: packageJson.build.win,
      nsis: packageJson.build.nsis,
    },
  };
}

await fs.rm(stageDir, { recursive: true, force: true });
await fs.mkdir(stageDir, { recursive: true });

await copyRequired('electron');
await removeTestFiles(path.join(stageDir, 'electron'));
await writeBundledServerConfig();
await copyRequired('dist');
await copyRequired('public');

const copiedRuntimeDependencies = [];
if (await copyNodeModule('ws')) {
  copiedRuntimeDependencies.push('ws');
} else {
  throw new Error('Required desktop dependency is missing from node_modules: ws');
}

const copiedOptionalDependencies = {};
for (const [name, version] of Object.entries(packageJson.optionalDependencies || {})) {
  if (await copyNodeModule(name)) {
    copiedOptionalDependencies[name] = version;
  }
}

for (const name of [
  '@nut-tree-fork/default-clipboard-provider',
  '@nut-tree-fork/libnut',
  '@nut-tree-fork/provider-interfaces',
  '@nut-tree-fork/shared',
  'jimp',
  'node-abort-controller',
  'temp',
]) {
  await copyNodeModule(name);
}

await fs.writeFile(
  path.join(stageDir, 'package.json'),
  `${JSON.stringify(buildDesktopPackageJson(copiedOptionalDependencies), null, 2)}\n`,
  'utf8',
);

console.log(`Prepared thin desktop app at ${path.relative(rootDir, stageDir)}`);
console.log(`Runtime dependencies: ${copiedRuntimeDependencies.join(', ')}`);
if (Object.keys(copiedOptionalDependencies).length) {
  console.log(`Optional dependencies: ${Object.keys(copiedOptionalDependencies).join(', ')}`);
}
