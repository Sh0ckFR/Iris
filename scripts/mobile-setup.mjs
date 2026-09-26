// After `tauri android init` / `tauri ios init`: what the generated mobile projects need for Iris.
//
//   node scripts/mobile-setup.mjs android   (run by `npm run android:init`)
//   node scripts/mobile-setup.mjs ios       (run by `npm run ios:init`)
//
// Android: the microphone permission (the webview asks the user at the first use, but only for a
// permission the app declares) and the audio settings used by the voice. iOS reads its extra keys
// from src-tauri/Info.ios.plist, merged by the Tauri CLI. Both get their icons from the eye.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2];
if (target !== 'android' && target !== 'ios') {
  console.error('usage: node scripts/mobile-setup.mjs android|ios');
  process.exit(1);
}

if (target === 'android') {
  const manifest = 'src-tauri/gen/android/app/src/main/AndroidManifest.xml';
  if (!existsSync(manifest)) {
    console.error(`${manifest} not found: run \`npx tauri android init\` first.`);
    process.exit(1);
  }
  let xml = readFileSync(manifest, 'utf8');
  const permissions = ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS'];
  const missing = permissions.filter((p) => !xml.includes(`"${p}"`));
  if (missing.length) {
    const lines = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
    xml = xml.replace(/(<manifest[^>]*>)/, `$1\n${lines}`);
    writeFileSync(manifest, xml);
    console.log(`AndroidManifest.xml: added ${missing.join(', ')}`);
  } else {
    console.log('AndroidManifest.xml: permissions already present');
  }
}

// App icons for the new project, from the same eye as the desktop app.
execSync('npx tauri icon src-tauri/icons/icon.svg', { stdio: 'inherit' });
