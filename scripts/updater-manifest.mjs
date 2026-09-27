// Writes latest.json, the file Iris's updater reads (tauri.conf.json → plugins.updater), from
// the installers of a release and their signatures (.sig, made when TAURI_SIGNING_PRIVATE_KEY is
// set at build time). Run by the release job of .github/workflows/build.yml:
//
//   node scripts/updater-manifest.mjs <folder with the installers> <tag> <owner/repo>
//
// Platform keys: `<os>-<arch>` (what any installed Iris asks for), and `<os>-<arch>-<installer>`
// (preferred by the updater when it knows how Iris was installed).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [dir, tag, repo] = process.argv.slice(2);
if (!dir || !tag || !repo) {
  console.error('usage: node scripts/updater-manifest.mjs <dir> <tag> <owner/repo>');
  process.exit(1);
}

const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    const path = join(d, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
})(dir);

/** [pattern on the installer's name, platform keys it serves] */
const RULES = [
  [/_x64-setup\.exe$/, ['windows-x86_64', 'windows-x86_64-nsis']],
  [/_x64_[\w-]+\.msi$/, ['windows-x86_64-msi']],
  [/_arm64-setup\.exe$/, ['windows-aarch64', 'windows-aarch64-nsis']],
  [/_arm64_[\w-]+\.msi$/, ['windows-aarch64-msi']],
  // One universal app for both Mac processors.
  [/\.app\.tar\.gz$/, ['darwin-aarch64', 'darwin-x86_64', 'darwin-aarch64-app', 'darwin-x86_64-app']],
  [/_amd64\.AppImage$/, ['linux-x86_64', 'linux-x86_64-appimage']],
  [/_aarch64\.AppImage$/, ['linux-aarch64', 'linux-aarch64-appimage']],
  [/_amd64\.deb$/, ['linux-x86_64-deb']],
  [/_arm64\.deb$/, ['linux-aarch64-deb']],
  [/\.x86_64\.rpm$/, ['linux-x86_64-rpm']],
  [/\.aarch64\.rpm$/, ['linux-aarch64-rpm']],
];

const platforms = {};
for (const file of files) {
  const name = basename(file);
  const rule = RULES.find(([pattern]) => pattern.test(name));
  const signature = files.find((f) => f === `${file}.sig`);
  if (!rule || !signature) continue;
  // GitHub stores release assets under their base name (spaces become dots).
  const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name.replace(/ /g, '.'))}`;
  for (const key of rule[1]) platforms[key] = { signature: readFileSync(signature, 'utf8').trim(), url };
}

if (Object.keys(platforms).length === 0) {
  console.error('no signed installer found: set the TAURI_SIGNING_PRIVATE_KEY secret to publish updates');
  process.exit(0);
}

const manifest = {
  version: tag.replace(/^v/, ''),
  notes: `https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json: ${manifest.version}, ${Object.keys(platforms).sort().join(', ')}`);
