// electron-builder afterPack hook for macOS builds made off a Mac.
//
// electron-builder can only codesign on macOS, and elsewhere it leaves the app
// with Electron's original signature, which no longer matches once the bundle
// is renamed and its Info.plist rewritten. Apple Silicon refuses to run arm64
// code whose signature is missing or invalid, so an unsigned cross-built app
// is killed at launch. This hook ad-hoc signs the bundle with rcodesign
// (https://github.com/indygreg/apple-platform-rs), which runs on Linux.
//
// Ad-hoc signing is not Developer ID signing: Gatekeeper still refuses a
// downloaded copy until the user allows it (see docs/desktop-self-hosted.md).
//
// The rcodesign binary is taken from $RCODESIGN, else from PATH.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform === 'darwin') {
    throw new Error('adhoc-sign-mac.cjs is for builds made off a Mac; on macOS let electron-builder sign.');
  }

  const rcodesign = process.env.RCODESIGN || 'rcodesign';
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // Files staged from a FUSE/NTFS checkout arrive as mode 777; drop group and
  // world write before the bundle is sealed so the signed tree is the shipped one.
  execFileSync('chmod', ['-R', 'go-w', appPath]);

  console.log(`  • ad-hoc signing  app=${appPath}`);
  execFileSync(rcodesign, ['sign', appPath], { stdio: 'inherit' });

  // `rcodesign verify` insists on a CMS blob, which an ad-hoc signature does
  // not have by definition, so check the properties that matter instead. A
  // full digest check (`codesign --verify --deep --strict`) exists only on macOS.
  const mainExecutable = path.join(appPath, 'Contents', 'MacOS', context.packager.appInfo.productFilename);
  const info = execFileSync(rcodesign, ['print-signature-info', mainExecutable], { encoding: 'utf8' });
  const expectedId = context.packager.appInfo.id;
  if (!info.includes('CodeSignatureFlags(ADHOC)') || !info.includes(`identifier: ${expectedId}`)) {
    throw new Error(`${mainExecutable} is not ad-hoc signed as ${expectedId}:\n${info}`);
  }
  console.log(`  • ad-hoc signature present  identifier=${expectedId}`);
};
