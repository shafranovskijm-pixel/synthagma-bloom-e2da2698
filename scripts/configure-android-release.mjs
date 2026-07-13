import { readFile, writeFile } from "node:fs/promises";

const versionCode = process.env.VERSION_CODE;
const versionName = process.env.VERSION_NAME;

if (!/^[1-9]\d*$/.test(versionCode ?? "")) {
  throw new Error("VERSION_CODE must be a positive integer");
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versionName ?? "")) {
  throw new Error("VERSION_NAME must look like 1.0.0");
}

const gradlePath = "android/app/build.gradle";
const manifestPath = "android/app/src/main/AndroidManifest.xml";

let gradle = await readFile(gradlePath, "utf8");
const updatedGradle = gradle
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/versionName\s+"[^"]+"/, `versionName "${versionName}"`);

if (updatedGradle === gradle) {
  throw new Error(`Could not update version fields in ${gradlePath}`);
}

await writeFile(gradlePath, updatedGradle);

let manifest = await readFile(manifestPath, "utf8");
const cameraPermission =
  '    <uses-permission android:name="android.permission.CAMERA" />';

if (!manifest.includes("android.permission.CAMERA")) {
  const internetPermission =
    /<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/;
  if (internetPermission.test(manifest)) {
    manifest = manifest.replace(
      internetPermission,
      (permission) => `${permission}\n${cameraPermission}`,
    );
  } else {
    manifest = manifest.replace(
      /(<manifest\b[^>]*>)/,
      `$1\n${cameraPermission}`,
    );
  }
  await writeFile(manifestPath, manifest);
}

console.log(`Configured Android release ${versionName} (${versionCode})`);
