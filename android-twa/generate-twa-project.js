/**
 * Generates the Android project from twa-manifest.json.
 *
 * This is the non-interactive equivalent of the tail end of `bubblewrap init`
 * (see @bubblewrap/cli/dist/lib/cmds/init.js): create the project from the
 * template, then write manifest-checksum.txt so that a later `bubblewrap build`
 * sees an up-to-date project and does not stop to ask whether to update it.
 */
const path = require('path');
const {TwaGenerator, TwaManifest, ConsoleLog} = require('@bubblewrap/core');
const {generateManifestChecksumFile} = require('@bubblewrap/cli/dist/lib/cmds/shared');

const TARGET_DIRECTORY = __dirname;
const MANIFEST_FILE = path.join(TARGET_DIRECTORY, 'twa-manifest.json');

async function main() {
  const twaManifest = await TwaManifest.fromFile(MANIFEST_FILE);

  const error = twaManifest.validate();
  if (error !== null) {
    throw new Error(`TWA manifest is invalid: ${error}`);
  }

  const twaGenerator = new TwaGenerator();
  await twaGenerator.createTwaProject(
      TARGET_DIRECTORY, twaManifest, new ConsoleLog('generate-twa-project'));
  await generateManifestChecksumFile(MANIFEST_FILE, TARGET_DIRECTORY);

  console.log(`Generated Android project in ${TARGET_DIRECTORY}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
