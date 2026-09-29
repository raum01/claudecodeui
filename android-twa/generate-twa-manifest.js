/**
 * Generates twa-manifest.json for the CloudCLI TWA wrapper without going through
 * bubblewrap's interactive `init`, so the build is reproducible.
 *
 * The manifest is derived from the live Web App Manifest (same code path bubblewrap
 * uses internally), then the handful of fields we pin are overridden. The signing key
 * is referenced by absolute path only -- neither the keystore nor its passwords are
 * ever written into this repository.
 */
const path = require('path');
const {TwaManifest} = require('@bubblewrap/core');

const WEB_MANIFEST_URL = 'https://cloudcli.rmz.sh/manifest.json';
const OUTPUT = path.join(__dirname, 'twa-manifest.json');

// Pinned: assetlinks.json on the server hardcodes this package name alongside the
// signing certificate fingerprint. Changing it breaks Digital Asset Links at runtime.
const APPLICATION_ID = 'sh.rmz.cloudcli';

async function main() {
  const twaManifest = await TwaManifest.fromWebManifest(WEB_MANIFEST_URL);

  twaManifest.packageId = APPLICATION_ID;
  twaManifest.host = 'cloudcli.rmz.sh';
  twaManifest.name = 'CloudCLI';
  twaManifest.launcherName = 'CloudCLI';
  twaManifest.appVersionName = '1.0.0';
  twaManifest.appVersionCode = 1;

  // 'customtabs' keeps this a real Trusted Web Activity: when asset link
  // verification succeeds there is no address bar. 'webview' would drop to a plain
  // WebView and lose the shared browser storage and the verified origin.
  twaManifest.fallbackType = 'customtabs';

  twaManifest.generatorApp = 'bubblewrap-cli';

  twaManifest.signingKey = {
    path: '/home/raum/.android-keystores/cloudcli-twa.keystore',
    alias: 'cloudcli',
  };

  const error = twaManifest.validate();
  if (error !== null) {
    throw new Error(`Generated TWA manifest is invalid: ${error}`);
  }

  await twaManifest.saveToFile(OUTPUT);
  console.log(`Wrote ${OUTPUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
