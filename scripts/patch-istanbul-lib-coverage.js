#!/usr/bin/env node

'use strict'

/*
 * Apply the upstream `FileCoverage.getLineCoverage` fix to the locked
 * `istanbul-lib-coverage` install. `getLineCoverage()` walks `statementMap`
 * only, so lines that carry an executable token but no statement entry
 * (function-declaration lines, `} else {` continuations, inline ternary arms)
 * never appear in the returned map. The `lcovonly` reporter emits `DA:`
 * records straight from that map, so Codecov's patch view marks those lines
 * as missing on every PR until upstream lands the fix.
 *
 * Idempotent — no-ops while the current sentinel is present. When the patch
 * body changes, the bumped sentinel makes it replace a stale dd-trace-js patch
 * in place, so existing installs self-heal on the next `prepare` instead of
 * keeping the old body. Fails loudly only if the upstream `getLineCoverage()`
 * shape changes, so a future yarn upgrade can't silently leave it unapplied.
 *
 * Wired to the `prepare` lifecycle so the script never fires on consumer
 * installs of the published tarball — the script itself is not in the
 * `files` allowlist. `prepare` also fires under `npm pack`, whose stdout
 * is captured by `FILENAME=$(npm pack --silent …)` in CI; all diagnostic
 * output therefore goes to stderr so the tarball name on stdout stays clean.
 *
 * Refs: https://github.com/istanbuljs/istanbuljs/issues/809
 */

const fs = require('node:fs')
const path = require('node:path')

// Inline marker so the script can detect a previous run without parsing the
// whole replacement body. Bump the version suffix when the patch body changes.
const SENTINEL = '// dd-trace-js patch v2: fold fnMap/branchMap into getLineCoverage'

// Version-agnostic prefix shared by every SENTINEL. Lets the script recognise a
// stale patch from an earlier version and replace it, rather than mistaking it
// for an upstream shape change.
const PATCH_MARKER = '// dd-trace-js patch'

const ORIGINAL = `    getLineCoverage() {
        const statementMap = this.data.statementMap;
        const statements = this.data.s;
        const lineMap = Object.create(null);

        Object.entries(statements).forEach(([st, count]) => {
            /* istanbul ignore if: is this even possible? */
            if (!statementMap[st]) {
                return;
            }
            const { line } = statementMap[st].start;
            const prevVal = lineMap[line];
            if (prevVal === undefined || prevVal < count) {
                lineMap[line] = count;
            }
        });
        return lineMap;
    }`

const REPLACEMENT = `    getLineCoverage() {
        ${SENTINEL}
        const lineMap = Object.create(null);

        const record = (line, count) => {
            const prev = lineMap[line];
            if (prev === undefined || prev < count) {
                lineMap[line] = count;
            }
        };

        const statementMap = this.data.statementMap;
        Object.entries(this.data.s).forEach(([st, count]) => {
            /* istanbul ignore if: is this even possible? */
            if (!statementMap[st]) return;
            record(statementMap[st].start.line, count);
        });

        const fnMap = this.data.fnMap;
        Object.entries(this.data.f).forEach(([fn, count]) => {
            const entry = fnMap[fn];
            /* istanbul ignore if: is this even possible? */
            if (!entry) return;
            const decl = entry.decl || entry.loc;
            /* istanbul ignore else: is this even possible? */
            if (decl && decl.start) record(decl.start.line, count);
        });

        const branchMap = this.data.branchMap;
        Object.entries(this.data.b).forEach(([br, counts]) => {
            const entry = branchMap[br];
            /* istanbul ignore if: is this even possible? */
            if (!entry || !Array.isArray(entry.locations)) return;
            entry.locations.forEach((branchLoc, i) => {
                // An \`if\` without an \`else\` still records a location for the
                // implicit else; istanbul leaves its start.line undefined, which
                // would otherwise land as a NaN line in the lcov report.
                if (typeof branchLoc?.start?.line === 'number') {
                    record(branchLoc.start.line, counts[i] | 0);
                }
            });
        });

        return lineMap;
    }`

// Matches the whole `getLineCoverage()` method, pristine or already patched, so
// a body change can be swapped in place. The closing `}` is the only one at the
// method's 4-space indentation; inner blocks close deeper.
const GET_LINE_COVERAGE_RE = /^ {4}getLineCoverage\(\) \{\n[\s\S]*?\n {4}\}/m

/**
 * @param {string} message
 */
function log (message) {
  process.stderr.write(`patch-istanbul-lib-coverage: ${message}\n`)
}

/**
 * @param {string} message
 */
function fail (message) {
  process.stderr.write(`patch-istanbul-lib-coverage: ${message}\n`)
  process.exitCode = 1
}

const repoRoot = path.resolve(__dirname, '..')

// Belt-and-braces guard against running from somewhere other than the
// dd-trace-js source checkout, in case a future change moves the script
// invocation off the `prepare` lifecycle.
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

let targetFile
try {
  targetFile = require.resolve('istanbul-lib-coverage/lib/file-coverage.js', { paths: [repoRoot] })
} catch {
  log('skipping: istanbul-lib-coverage is not installed yet')
  return
}

const source = fs.readFileSync(targetFile, 'utf8')
const relativeTarget = path.relative(repoRoot, targetFile)

if (source.includes(SENTINEL)) {
  log(`already patched at ${relativeTarget}`)
  return
}

const existing = source.match(GET_LINE_COVERAGE_RE)
if (existing === null) {
  fail(
    `refusing to patch ${relativeTarget}: could not locate getLineCoverage(). ` +
    'Re-verify the patch against the new upstream code before bumping istanbul-lib-coverage.'
  )
  return
}

// Pristine upstream must match byte-for-byte; anything else without our marker
// means the upstream shape changed and the patch needs re-verifying. A body
// carrying the marker is an earlier patch version and is replaced in place.
const current = existing[0]
if (current !== ORIGINAL && !current.includes(PATCH_MARKER)) {
  fail(
    `refusing to patch ${relativeTarget}: upstream getLineCoverage() shape has changed. ` +
    'Re-verify the patch against the new upstream code before bumping istanbul-lib-coverage.'
  )
  return
}

fs.writeFileSync(targetFile, source.replace(current, REPLACEMENT))
log(`patched ${relativeTarget}`)
