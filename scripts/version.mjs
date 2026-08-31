// Keeps package.json and the plugin manifest on the same version, and checks a
// release tag against them. Stream Deck wants four numeric parts, npm wants
// three, so 1.2.0 becomes 1.2.0.0 in the manifest.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const manifestPath = join(root, "com.claudify.agents.sdPlugin", "manifest.json");

const args = process.argv.slice(2);
const check = args[0] === "--check";
const raw = (check ? args[1] : args[0]) ?? "";
const version = raw.replace(/^v/, "");

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`usage: node scripts/version.mjs [--check] <x.y.z>  (got "${raw}")`);
  process.exit(1);
}

const manifestVersion = `${version}.0`;
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

if (check) {
  const pkg = read(pkgPath);
  const manifest = read(manifestPath);
  const problems = [];
  if (pkg.version !== version) {
    problems.push(`package.json is ${pkg.version}, tag says ${version}`);
  }
  if (manifest.Version !== manifestVersion) {
    problems.push(`manifest.json is ${manifest.Version}, tag says ${manifestVersion}`);
  }
  if (problems.length) {
    console.error(`Version mismatch:\n  ${problems.join("\n  ")}`);
    console.error(`Run: npm run bump -- ${version}`);
    process.exit(1);
  }
  console.log(`Versions match tag v${version}.`);
} else {
  // Rewrite the one line rather than re-serialising, so formatting survives.
  for (const [path, pattern, next] of [
    [pkgPath, /("version":\s*)"[^"]*"/, `"${version}"`],
    [manifestPath, /("Version":\s*)"[^"]*"/, `"${manifestVersion}"`],
  ]) {
    const text = readFileSync(path, "utf8");
    if (!pattern.test(text)) {
      console.error(`No version field found in ${path}`);
      process.exit(1);
    }
    writeFileSync(path, text.replace(pattern, `$1${next}`));
  }
  console.log(`Set package.json to ${version} and manifest.json to ${manifestVersion}.`);
}
