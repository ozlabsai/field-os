// Fail the build if the bundle would reach the internet at runtime (OZL-293).
//
// The defect this exists to catch is invisible in source: `@monaco-editor/react` shipped a loader
// whose default config fetched Monaco from jsDelivr, so the code editor simply never appeared on an
// airgapped deployment. The URL was never in our code -- it arrived inside a dependency's default
// config and was only visible after bundling. Every source-level audit missed it.
//
// So this scans built output, and it is deliberately an allowlist of known-inert hosts rather than
// a denylist of bad ones: the next dependency to embed a CDN will use a host nobody thought to ban.
//
// A hit is not automatically a defect -- a URL can be placeholder text or an error-message string --
// which is why each entry below records WHY it is inert. Anything new must be justified the same
// way, or fixed.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;

// Hosts that appear in the bundle as inert strings, each with the reason it cannot cause a fetch.
const ALLOWED = new Map([
  ["www.w3.org", "SVG/XML namespace URIs, never fetched"],
  ["example.com", "placeholder text in admin input fields"],
  ["status.example.com", "placeholder text in the admin banner field"],
  ["react.dev", "React error-message links"],
  ["fb.me", "legacy React warning links"],
  ["localhost", "dev-server defaults, not reachable in production"],
  ["vllm.internal", "documentation example for the inference endpoint"],
  ["base-ui.com", "component-library error-message links"],
  ["code.visualstudio.com", "Monaco error-message links"],
  ["microsoft.com", "Monaco license/attribution strings"],
  ["github.com", "attribution and error-message links"],
  ["dash.cloudflare.com", "link shown to an operator, not fetched by the app"],
  ["developers.cloudflare.com", "documentation links"],
  ["kumo.cfops.it", "component-library documentation links"],
  ["...", "literal placeholder text in an API URL input field"],
  // Unreachable dead config, verified by execution rather than by reading: `loader.config({monaco})`
  // in monacoTheme.ts makes `loader.init()` resolve from the local bundle with ZERO script tags
  // injected. Without that call `init()` never resolves at all -- which was OZL-293. The default
  // constant remains in the dependency's code; nothing reads it.
  ["cdn.jsdelivr.net", "@monaco-editor/loader default config, superseded by loader.config({monaco})"],
  // Unreachable dead config, verified by execution rather than by reading: `loader.config({monaco})`
  // in monacoTheme.ts makes `loader.init()` resolve from the local bundle with ZERO script tags
  // injected. Without that call `init()` never resolves at all -- which was OZL-293. The default
  // constant remains in the dependency's code; nothing reads it.
  
]);

const files = (await readdir(join(DIST, "assets"))).filter(f => f.endsWith(".js") || f.endsWith(".css"));
const found = new Map();
for (const file of files) {
  const text = await readFile(join(DIST, "assets", file), "utf8");
  for (const [, host] of text.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) {
    if (!ALLOWED.has(host)) found.set(host, file);
  }
}

if (found.size > 0) {
  console.error("Airgap check failed: unrecognized external host(s) in the built bundle.\n");
  for (const [host, file] of found) console.error(`  ${host}  (in assets/${file})`);
  console.error(`
A deployment with no internet route cannot reach these. Either:
  * the code genuinely fetches it -- bundle it locally instead (see monacoTheme.ts), or
  * it is an inert string (placeholder text, an error-message link, an XML namespace) -- add it to
    ALLOWED in this script WITH the reason it cannot cause a fetch.

Do not add an entry without checking which it is.`);
  process.exit(1);
}

console.log(`Airgap check passed: ${files.length} bundled files, no unrecognized external hosts.`);
