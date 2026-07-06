#!/usr/bin/env node

'use strict'

/*
 * Apply the missing arg-forwarding fix to the locked `append-transform`
 * install (required by `istanbul-lib-hook`, which is required by `nyc`). The
 * package's `replacementCompile` calls `module._compile(code, filename)` with
 * just two arguments and drops anything else. Node 22+ passes a third
 * `format` argument to `Module.prototype._compile` for ESM modules loaded
 * synchronously via `require()`, and our rewriter relies on that arg to
 * pick the ESM transformer. Under coverage, the strip reaches our rewriter
 * as `format === undefined`, ESM-only packages (e.g. `ai@7`) get treated as
 * CJS, and the CJS transformer splices `require()` into ESM source — the
 * file then crashes at load with "require is not defined in ES module scope".
 *
 * Idempotent — no-ops while the current sentinel is present. When the patch
 * body changes, the bumped sentinel makes it replace a stale dd-trace-js
 * patch in place, so existing installs self-heal on the next `prepare`
 * instead of keeping the old body. Fails loudly only if the upstream
 * `replacementCompile` shape changes, so a future yarn upgrade can't
 * silently leave it unapplied.
 *
 * Wired to the `prepare` lifecycle so the script never fires on consumer
 * installs of the published tarball — the script itself is not in the
 * `files` allowlist. `prepare` also fires under `npm pack`, whose stdout is
 * captured by `FILENAME=$(npm pack --silent …)` in CI; all diagnostic output
 * therefore goes to stderr so the tarball name on stdout stays clean.
 *
 * Upstream is effectively unmaintained (last release 2019, pre-dates Node's
 * require-of-ESM support); no point chasing a PR there. See
 * https://github.com/istanbuljs/append-transform/blob/v2.0.0/index.js#L57-L61
 * for the upstream code being replaced.
 */

const fs = require('node:fs')
const path = require('node:path')

const SENTINEL = '// dd-trace-js patch v1: forward extra args (Node 22+ ESM format)'

const PATCH_MARKER = '// dd-trace-js patch'

// Upstream `append-transform/index.js` is tab-indented at 4 tabs for the
// `replacementCompile` assignment / closing `};`, and 5 tabs for the body.
const ORIGINAL = '\t\t\t\tmodule._compile = function replacementCompile(code, filename) {\n' +
  '\t\t\t\t\tmodule._compile = originalCompile;\n' +
  '\t\t\t\t\tcode = transform(code, filename);\n' +
  '\t\t\t\t\tmodule._compile(code, filename);\n' +
  '\t\t\t\t};'

const REPLACEMENT = '\t\t\t\tmodule._compile = function replacementCompile(code, filename, ...rest) {\n' +
  `\t\t\t\t\t${SENTINEL}\n` +
  '\t\t\t\t\tmodule._compile = originalCompile;\n' +
  '\t\t\t\t\tcode = transform(code, filename);\n' +
  '\t\t\t\t\tmodule._compile(code, filename, ...rest);\n' +
  '\t\t\t\t};'

// Matches the whole `replacementCompile` assignment (pristine or already
// patched) so a body change can be swapped in place. Upstream uses tabs at
// 4 levels of indentation for the assignment and its closing `};`.
const REPLACEMENT_COMPILE_RE = /\t{4}module\._compile = function replacementCompile\([\s\S]*?\n\t{4}\};/

/**
 * @param {string} message
 */
function log (message) {
  process.stderr.write(`patch-append-transform: ${message}\n`)
}

/**
 * @param {string} message
 */
function fail (message) {
  process.stderr.write(`patch-append-transform: ${message}\n`)
  process.exitCode = 1
}

const repoRoot = path.resolve(__dirname, '..')

// Belt-and-braces guard against running from somewhere other than the
// dd-trace-js source checkout, in case a future change moves the script
// invocation off the `prepare` lifecycle.
const requiredMarkers = [
  path.join(repoRoot, 'eslint.config.mjs'),
  path.join(repoRoot, 'packages', 'datadog-instrumentations'),
]

for (const marker of requiredMarkers) {
  if (!fs.existsSync(marker)) {
    log(`skipping: not running inside the dd-trace-js source checkout (missing ${path.relative(repoRoot, marker)})`)
    return
  }
}

// `append-transform` is a transitive dep of `nyc`, not a direct dependency,
// so avoid `require.resolve` (which would trip `n/no-extraneous-require`) and
// look up the file by its conventional location instead.
const targetFile = path.join(repoRoot, 'node_modules', 'append-transform', 'index.js')
if (!fs.existsSync(targetFile)) {
  log('skipping: append-transform is not installed yet')
  return
}

const source = fs.readFileSync(targetFile, 'utf8')
const relativeTarget = path.relative(repoRoot, targetFile)

if (source.includes(SENTINEL)) {
  log(`already patched at ${relativeTarget}`)
  return
}

const existing = source.match(REPLACEMENT_COMPILE_RE)
if (existing === null) {
  fail(
    `refusing to patch ${relativeTarget}: could not locate replacementCompile. ` +
    'Re-verify the patch against the new upstream code before bumping append-transform.'
  )
  return
}

// Pristine upstream must match (modulo whitespace) the captured ORIGINAL;
// anything else without our marker means upstream shape changed and the
// patch needs re-verifying. A body carrying the marker is an earlier patch
// version and is replaced in place.
const current = existing[0]
const normalize = (str) => str.replaceAll(/\s+/g, ' ').trim()
if (normalize(current) !== normalize(ORIGINAL) && !current.includes(PATCH_MARKER)) {
  fail(
    `refusing to patch ${relativeTarget}: upstream replacementCompile shape has changed. ` +
    'Re-verify the patch against the new upstream code before bumping append-transform.'
  )
  return
}

fs.writeFileSync(targetFile, source.replace(current, REPLACEMENT))
log(`patched ${relativeTarget}`)
