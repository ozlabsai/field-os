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

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// Targets default to this package's own build output; pass paths (a directory or a single bundled
// file) to check another package's. The gatekeeper management UIs bundle separately and ship as a
// single `app.txt`, so they need the file form.
const targets = process.argv.slice(2);
if (targets.length === 0) targets.push(new URL("../dist/assets/", import.meta.url).pathname);

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
  // Reached by TWO dependencies, both superseded by locally-supplied data. Neither fetches.
  //
  //   * `@monaco-editor/loader` -- its default config points here. `loader.config({monaco})` in
  //     monacoTheme.ts supersedes it: verified by execution, `init()` resolves from the local
  //     bundle with ZERO script tags injected, and WITHOUT that call it never resolves at all
  //     (OZL-293).
  //   * `emoji-mart` in the Context Library UI -- falls back to jsDelivr for emoji data and for
  //     i18n. Both are bypassed: `data: emojiData` is passed from the locally imported
  //     `@emoji-mart/data`, and the i18n fetch only fires for a non-`en` locale, which nothing
  //     configures.
  //
  // Both remain as dead constants in compiled dependency code. If either local supply is ever
  // removed, the fetch silently comes back -- and this allowlist entry would hide it, so check
  // both call sites before trusting this line.
  ["cdn.jsdelivr.net", "dead fallback in @monaco-editor/loader and emoji-mart; both supplied locally"],
  // Unreachable dead config, verified by execution rather than by reading: `loader.config({monaco})`
  // in monacoTheme.ts makes `loader.init()` resolve from the local bundle with ZERO script tags
  // injected. Without that call `init()` never resolves at all -- which was OZL-293. The default
  // constant remains in the dependency's code; nothing reads it.
  
]);

// Expand each target to the list of files to scan.
const files = [];
for (const target of targets) {
  if ((await stat(target)).isDirectory()) {
    for (const name of await readdir(target)) {
      if (name.endsWith(".js") || name.endsWith(".css")) files.push(join(target, name));
    }
  } else {
    files.push(target);
  }
}

// Gatekeeper configurator UIs are embedded percent-encoded (the module is inlined into a data: URL),
// so `https://` appears as `https%3A%2F%2F` and a plain scan sees nothing. Decoding first is what
// makes the check able to fail on those bundles at all -- without it the guard silently passes
// everything, which is worse than no guard because it reads as coverage.
// Matches a host after either form. Decoding the WHOLE file does not work -- these bundles contain
// stray `%` that make `decodeURIComponent` throw on the full string -- so the encoded form is
// matched directly instead.
const HOST_PATTERNS = [
  /https?:\/\/([a-zA-Z0-9._-]+)/g,          // plain
  /https?%3A%2F%2F([a-zA-Z0-9._-]+)/gi,     // percent-encoded
];

const found = new Map();
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const pattern of HOST_PATTERNS) {
    for (const [, host] of text.matchAll(pattern)) {
      if (!ALLOWED.has(host)) found.set(host, file);
    }
  }
}

if (found.size > 0) {
  console.error("Airgap check failed: unrecognized external host(s) in the built bundle.\n");
  for (const [host, file] of found) console.error(`  ${host}  (in ${file})`);
  console.error(`
A deployment with no internet route cannot reach these. Either:
  * the code genuinely fetches it -- bundle it locally instead (see monacoTheme.ts), or
  * it is an inert string (placeholder text, an error-message link, an XML namespace) -- add it to
    ALLOWED in this script WITH the reason it cannot cause a fetch.

Do not add an entry without checking which it is.`);
  process.exit(1);
}

console.log(`Airgap check passed: ${files.length} bundled file(s), no unrecognized external hosts.`);
