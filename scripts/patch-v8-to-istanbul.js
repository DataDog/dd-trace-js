#!/usr/bin/env node

'use strict'

/*
 * Fix c8 / v8-to-istanbul over-reporting line coverage on multi-line statements.
 *
 * v8-to-istanbul seeds every line with `count = 1` and only zeroes a line when a V8 `count: 0`
 * range *fully* spans it (`startCol <= line.startCol && endCol >= line.endCol`). A line whose
 * executable content is preceded by indentation or a leading token therefore never gets zeroed,
 * so the un-taken arm of a multi-line construct is reported as covered:
 *
 *     this.#buffer = radix === 16
 *       ? createBuffer(value)      // taken    -> count 1 (correct)
 *       : fromString(value, radix) // NOT taken -> count 1 (WRONG; V8's count:0 range starts at the
 *                                  //              `:`, past the indent, so the full-span guard misses)
 *
 * istanbul (statement-granular) reports that line as 0. To keep the two reporters comparable on
 * line coverage — the metric Codecov gates on — we relax the zeroing guard so a `count: 0` range
 * that covers a line from its first non-whitespace column through the line end also zeroes it.
 * Leading indentation and a single leading token (`:`/`&&`/`??`/`?`) no longer keep a dead line
 * green, while a genuine second statement later on the line (`a(); b()`) is untouched, because
 * such a range would not start at the line's first non-whitespace column.
 *
 * Two coordinated edits, one file each, applied together:
 *   1. lib/line.js          — record `firstColumn` (absolute col of the first non-whitespace char)
 *                             on every CovLine, so the guard can reason about the executable extent.
 *   2. lib/v8-to-istanbul.js — widen the line-zeroing guard to accept the first-non-whitespace span.
 *
 * Idempotent — no-ops while the current sentinel is present. When a patch body changes, the bumped
 * sentinel replaces the stale dd-trace-js patch in place so existing installs self-heal on the next
 * `prepare`. Fails loudly only if the upstream shape changes, so a future bump can't silently leave
 * it unapplied.
 *
 * Wired to the `prepare` lifecycle so it never fires on consumer installs of the published tarball
 * (the script is not in the `files` allowlist). Diagnostics go to stderr so `npm pack`'s stdout
 * (the tarball name) stays clean.
 *
 * Refs: https://github.com/bcoe/c8/issues (line-coverage over-report on multi-line statements)
 */

const fs = require('node:fs')
const path = require('node:path')

const LINE_SENTINEL = '// dd-trace-js patch v1: record firstColumn for the line-zeroing guard'
const APPLY_SENTINEL = '// dd-trace-js patch v1: zero lines covered from first non-whitespace column'
const PATCH_MARKER = '// dd-trace-js patch'

// ---- target 1: lib/line.js ----

const LINE_ORIGINAL = `    // we start with all lines having been executed, and work
    // backwards zeroing out lines based on V8 output.
    this.count = 1`

const LINE_REPLACEMENT = `    // we start with all lines having been executed, and work
    // backwards zeroing out lines based on V8 output.
    this.count = 1

    ${LINE_SENTINEL}
    // Absolute column of the first non-whitespace character on the line. The line-zeroing guard
    // in v8-to-istanbul.js uses it so an indented, un-taken sub-expression (a ternary/logical arm
    // on its own line) can be zeroed even though leading whitespace is not covered by the range.
    let leadingWhitespace = 0
    while (leadingWhitespace < lineStr.length) {
      const code = lineStr.charCodeAt(leadingWhitespace)
      if (code !== 32 && code !== 9) break
      leadingWhitespace++
    }
    this.firstColumn = startCol + leadingWhitespace`

// Matches the count/ignore initializer block, pristine or already patched, so a body change can be
// swapped in place. Anchored on the two stable comment lines plus `this.count = 1`.
const LINE_RE = new RegExp(
  String.raw` {4}// we start with all lines having been executed, and work\n` +
  String.raw` {4}// backwards zeroing out lines based on V8 output\.\n` +
  String.raw` {4}this\.count = 1(?:\n[\s\S]*?this\.firstColumn = startCol \+ leadingWhitespace)?`
)

// ---- target 2: lib/v8-to-istanbul.js ----

const APPLY_ORIGINAL = `          if (startCol <= line.startCol && endCol >= line.endCol && !line.ignore) {
            line.count = range.count
          }`

const APPLY_REPLACEMENT = `          ${APPLY_SENTINEL}
          // Original guard zeroes a line only when the range fully spans it (indentation included),
          // which leaves indented un-taken arms of multi-line statements reported as covered. Also
          // accept a range that covers the line from its first non-whitespace column through the
          // line end, so a dead \`: expr\` / \`&& expr\` / \`?? expr\` continuation line is zeroed while
          // a genuine second statement later on the line (which would start past firstColumn) is not.
          const spansLine = startCol <= line.startCol && endCol >= line.endCol
          const spansExecutable = startCol <= line.firstColumn && endCol >= line.endCol
          if ((spansLine || spansExecutable) && !line.ignore) {
            line.count = range.count
          }`

// Matches the guard, pristine or patched. The patched form carries the sentinel; the pristine form
// is the single-line `if`. Either is replaced in place.
const APPLY_RE = new RegExp(
  String.raw`(?: {10}// dd-trace-js patch v1: zero lines covered from first non-whitespace column\n[\s\S]*?)?` +
  String.raw` {10}if \(startCol <= line\.startCol && endCol >= line\.endCol && !line\.ignore\) \{\n` +
  String.raw` {12}line\.count = range\.count\n {10}\}`
)

function log (message) {
  process.stderr.write(`patch-v8-to-istanbul: ${message}\n`)
}

function fail (message) {
  process.stderr.write(`patch-v8-to-istanbul: ${message}\n`)
  process.exitCode = 1
}

const repoRoot = path.resolve(__dirname, '..')

const requiredMarkers = [
  path.join(repoRoot, 'eslint.config.mjs'),
  path.join(repoRoot, 'packages', 'datadog-instrumentations'),
  path.join(repoRoot, 'integration-tests', 'coverage', 'merge-lcov.js'),
]

for (const marker of requiredMarkers) {
  if (!fs.existsSync(marker)) {
    log(`skipping: not running inside the dd-trace-js source checkout (missing ${path.relative(repoRoot, marker)})`)
    return
  }
}

/**
 * Apply one in-place replacement to a target file, idempotent and fail-loud.
 *
 * @param {string} relTarget module-relative path resolved from the repo root
 * @param {string} sentinel  marker proving this patch version is applied
 * @param {RegExp} re        matches the region, pristine or previously patched
 * @param {string} original  exact pristine text (mismatch without the marker = upstream changed)
 * @param {string} replacement
 * @returns {boolean} whether the file is now patched
 */
function applyPatch (relTarget, sentinel, re, original, replacement) {
  let targetFile
  try {
    targetFile = require.resolve(relTarget, { paths: [repoRoot] })
  } catch {
    log(`skipping: ${relTarget} is not installed yet`)
    return false
  }

  const source = fs.readFileSync(targetFile, 'utf8')
  const relativeTarget = path.relative(repoRoot, targetFile)

  if (source.includes(sentinel)) {
    log(`already patched at ${relativeTarget}`)
    return true
  }

  const existing = source.match(re)
  if (existing === null) {
    fail(
      `refusing to patch ${relativeTarget}: could not locate the target region. ` +
      'Re-verify the patch against the new upstream code before bumping v8-to-istanbul.'
    )
    return false
  }

  const current = existing[0]
  if (current !== original && !current.includes(PATCH_MARKER)) {
    fail(
      `refusing to patch ${relativeTarget}: upstream shape has changed. ` +
      'Re-verify the patch against the new upstream code before bumping v8-to-istanbul.'
    )
    return false
  }

  fs.writeFileSync(targetFile, source.replace(current, replacement))
  log(`patched ${relativeTarget}`)
  return true
}

const lineOk = applyPatch(
  'v8-to-istanbul/lib/line.js', LINE_SENTINEL, LINE_RE, LINE_ORIGINAL, LINE_REPLACEMENT
)
const applyOk = applyPatch(
  'v8-to-istanbul/lib/v8-to-istanbul.js', APPLY_SENTINEL, APPLY_RE, APPLY_ORIGINAL, APPLY_REPLACEMENT
)

if (lineOk && applyOk) {
  log('v8-to-istanbul line-coverage over-report patch is in place')
}
