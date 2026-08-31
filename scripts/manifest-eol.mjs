// `streamdeck pack` rewrites the manifest and drops its trailing newline, which
// leaves a one-byte diff behind after every build. Put it back.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const path = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "com.claudify.agents.sdPlugin",
  "manifest.json",
);
const text = readFileSync(path, "utf8");
if (!text.endsWith("\n")) writeFileSync(path, `${text}\n`);
