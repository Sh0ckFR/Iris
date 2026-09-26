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

  // Release signing: used when src-tauri/gen/android/keystore.properties exists (written by CI
  // from the repository secrets, or by hand), with storeFile, storePassword, keyAlias, keyPassword.
  // Without it, release builds stay unsigned and debug builds use the debug key, as before.
  const gradle = 'src-tauri/gen/android/app/build.gradle.kts';
  let kts = readFileSync(gradle, 'utf8');
  if (kts.includes('irisKeystore')) {
    console.log('build.gradle.kts: release signing already set up');
  } else {
    const androidBlock = /^android \{\r?\n/m;
    const releaseType = /getByName\("release"\) \{\r?\n/;
    if (!androidBlock.test(kts) || !releaseType.test(kts)) {
      console.error(`${gradle}: unexpected layout, release signing not added (see https://v2.tauri.app/distribute/sign/android/)`);
      process.exit(1);
    }
    const declarations = [
      '// Iris: release signing from keystore.properties (scripts/mobile-setup.mjs).',
      'val irisKeystore = rootProject.file("keystore.properties")',
      'val irisKeystoreProperties = java.util.Properties().apply { if (irisKeystore.exists()) irisKeystore.inputStream().use { load(it) } }',
      '',
    ].join('\n');
    const signingConfig = [
      '    if (irisKeystore.exists()) {',
      '        signingConfigs {',
      '            create("release") {',
      '                storeFile = file(irisKeystoreProperties.getProperty("storeFile"))',
      '                storePassword = irisKeystoreProperties.getProperty("storePassword")',
      '                keyAlias = irisKeystoreProperties.getProperty("keyAlias")',
      '                keyPassword = irisKeystoreProperties.getProperty("keyPassword")',
      '            }',
      '        }',
      '    }',
      '',
    ].join('\n');
    kts = kts
      .replace(androidBlock, (m) => `${declarations}\n${m}${signingConfig}`)
      .replace(releaseType, (m) => `${m}            if (irisKeystore.exists()) signingConfig = signingConfigs.getByName("release")\n`);
    writeFileSync(gradle, kts);
    console.log('build.gradle.kts: release signing added (active when keystore.properties exists)');
  }
}

// App icons for the new project, from the same eye as the desktop app.
execSync('npx tauri icon src-tauri/icons/icon.svg', { stdio: 'inherit' });
