'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { Glob } = require('glob')
const { Minimatch } = require('minimatch')

const TEST_FILE_GLOB = '**/*.@(spec|test).@(js|mjs|cjs)'

// Case-insensitive because `glob` matches case-insensitively on darwin and win32. Indexing a
// `FOO.SPEC.JS` that a case-sensitive platform would reject is harmless: the pattern matcher
// applies that platform's own rules and drops it again.
const TEST_FILE_NAME = /\.(?:spec|test)\.(?:js|mjs|cjs)$/i

// Any character that can start a wildcard, brace, class, or extglob. Over-reporting only shortens
// the literal prefix, which widens the candidate set and can never drop a match.
const PATTERN_MAGIC = /[*?[\]{}()!+@\\]/

// `glob` walks `..` on the real filesystem before matching. The index has no tree to walk, so it
// would answer such a pattern with too few files and report exercised specs as unexercised.
const PARENT_SEGMENT = /(?:^|\/)\.\.(?:\/|$)/

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
function walkTestFiles (repoRoot) {
  /** @type {string[]} */
  const found = []
  /** @type {string[]} */
  const pending = ['']

  while (pending.length) {
    const relativeDir = pending.pop()

    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = fs.readdirSync(path.join(repoRoot, relativeDir), { withFileTypes: true })
    } catch (error) {
      // `glob` skips unreadable directories without a word. Staying silent here would shrink the
      // index instead, and an unexercised spec below that directory would pass the check unseen.
      process.stderr.write(`test-file-index: skipped unreadable ${relativeDir || '.'} (${error.code})\n`)
      continue
    }

    for (const entry of entries) {
      const { name } = entry

      // `glob` runs with `dot: false`, so a dot entry can never satisfy TEST_FILE_GLOB. Every
      // consumer of this index also ignores `node_modules`, so descending into it is dead work.
      if (name.startsWith('.') || name === 'node_modules') continue

      const relativePath = relativeDir ? `${relativeDir}/${name}` : name

      if (entry.isDirectory()) {
        pending.push(relativePath)
      } else if (TEST_FILE_NAME.test(name)) {
        // Symlinks are kept: `nodir: true` filters directories, not links to files.
        found.push(relativePath)
      }
    }
  }

  return found
}

/**
 * Drops `.` and empty path segments the way `glob` does while building its pattern. `minimatch`
 * on a bare string keeps them and would then compare one segment too many.
 *
 * @param {string} pattern
 * @returns {string}
 */
function normalizePattern (pattern) {
  if (!pattern.includes('./') && !pattern.includes('//')) return pattern

  const segments = pattern.split('/')
  let normalized = ''
  let hasSegment = false

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    // A leading empty segment marks an absolute pattern and a trailing one a directory-only
    // pattern; both change what matches, so only interior blanks are collapsed.
    if (segment === '.' || (segment === '' && i !== 0 && i !== segments.length - 1)) continue
    if (hasSegment) normalized += '/'
    normalized += segment
    hasSegment = true
  }

  return normalized
}

/**
 * Longest leading directory path of `pattern` that contains no wildcard.
 *
 * @param {string} pattern
 * @returns {string}
 */
function literalPrefix (pattern) {
  const magic = pattern.search(PATTERN_MAGIC)
  const literal = magic === -1 ? pattern : pattern.slice(0, magic)
  const lastSlash = literal.lastIndexOf('/')
  return lastSlash === -1 ? '' : literal.slice(0, lastSlash + 1)
}

/**
 * In-memory stand-in for repeated `globSync` walks over the repository's test files.
 *
 * The repository is traversed once; every later pattern is answered from the resulting list. Only
 * paths named like a test file are indexed, so a pattern that also selects non-test files reports
 * just the test-file subset.
 *
 * Results have to stay identical to the `globSync` walk they replace; `test-file-index.spec.js`
 * pins that against `glob` itself, including the repository's own pattern corpus.
 */
class TestFileIndex {
  /** @type {string[]} */
  files

  /** @type {boolean} */
  #nocase

  /** @type {typeof process.platform} */
  #platform

  /** @type {Map<string, InstanceType<typeof Minimatch>>} */
  #matchers = new Map()

  /** @type {Map<string, InstanceType<typeof Minimatch>>} */
  #ignoreMatchers = new Map()

  /** @type {Map<string, { files: string[], folded: string[] }>} */
  #scopes = new Map()

  /** @type {Map<string, string[]>} */
  #candidates = new Map()

  /**
   * @param {string[]} files Sorted repository-relative POSIX paths.
   * @param {{ nocase: boolean, platform: typeof process.platform }} options
   */
  constructor (files, { nocase, platform }) {
    this.files = files
    this.#nocase = nocase
    this.#platform = platform
  }

  /**
   * A literal path segment is compared case-sensitively on every platform, which is what `glob`
   * does on Linux. On a case-insensitive filesystem `glob` instead resolves `foo/BAR.spec.js` to
   * the differently-spelled file on disk; reproducing that would make the result depend on the
   * developer's machine, so the index keeps the Linux rule everywhere.
   *
   * @param {string} pattern
   * @param {string[]} [ignoreGlobs]
   * @throws {Error} If `pattern` contains a `..` segment, which the index cannot resolve.
   * @returns {string[]} Matching paths, in the index's sort order.
   */
  match (pattern, ignoreGlobs = []) {
    if (PARENT_SEGMENT.test(pattern)) {
      throw new Error(`test-file-index cannot resolve the '..' segment in pattern '${pattern}'`)
    }

    const normalized = normalizePattern(pattern)
    const scope = this.#scope(ignoreGlobs)
    const matcher = this.#matcher(normalized)

    /** @type {string[]} */
    const matched = []
    for (const file of this.#candidatesFor(scope, ignoreGlobs, normalized)) {
      // eslint-disable-next-line unicorn/prefer-regexp-test -- Minimatch#match, not String#match.
      if (matcher.match(file)) matched.push(file)
    }

    return matched
  }

  /**
   * @param {string[]} ignoreGlobs
   * @returns {{ files: string[], folded: string[] }}
   */
  #scope (ignoreGlobs) {
    const key = ignoreGlobs.join('\0')

    let scope = this.#scopes.get(key)
    if (scope === undefined) {
      const matchers = ignoreGlobs.map(glob => this.#ignoreMatcher(glob))
      const files = matchers.length === 0
        ? this.files
        : this.files.filter(file => !matchers.some(matcher => matcher.match(file) || matcher.match(`${file}/`)))

      scope = { files, folded: this.#nocase ? files.map(file => file.toLowerCase()) : files }
      this.#scopes.set(key, scope)
    }

    return scope
  }

  /**
   * @param {{ files: string[], folded: string[] }} scope
   * @param {string[]} ignoreGlobs
   * @param {string} pattern
   * @returns {string[]}
   */
  #candidatesFor (scope, ignoreGlobs, pattern) {
    const prefix = literalPrefix(pattern)
    if (prefix === '') return scope.files

    const key = `${ignoreGlobs.join('\0')}\0${prefix}`

    let candidates = this.#candidates.get(key)
    if (candidates === undefined) {
      const wanted = this.#nocase ? prefix.toLowerCase() : prefix

      candidates = []
      for (let i = 0; i < scope.files.length; i++) {
        if (scope.folded[i].startsWith(wanted)) candidates.push(scope.files[i])
      }

      this.#candidates.set(key, candidates)
    }

    return candidates
  }

  /**
   * @param {string} pattern
   * @returns {InstanceType<typeof Minimatch>}
   */
  #matcher (pattern) {
    let matcher = this.#matchers.get(pattern)
    if (matcher === undefined) {
      matcher = new Minimatch(pattern, {
        dot: false,
        nocase: this.#nocase,
        nocaseMagicOnly: this.#platform === 'darwin' || this.#platform === 'win32',
        nocomment: true,
        nonegate: true,
        optimizationLevel: 2,
        platform: this.#platform,
        windowsPathsNoEscape: true,
      })
      this.#matchers.set(pattern, matcher)
    }

    return matcher
  }

  /**
   * @param {string} glob
   * @returns {InstanceType<typeof Minimatch>}
   */
  #ignoreMatcher (glob) {
    let matcher = this.#ignoreMatchers.get(glob)
    if (matcher === undefined) {
      // Mirrors the options `glob`'s Ignore class builds; notably `dot: true`, so `**/.git/**`
      // still matches paths that the main pattern would skip.
      matcher = new Minimatch(glob, {
        dot: true,
        nocase: this.#nocase,
        nocomment: true,
        nonegate: true,
        optimizationLevel: 2,
        platform: this.#platform,
      })
      this.#ignoreMatchers.set(glob, matcher)
    }

    return matcher
  }
}

/**
 * @param {string} repoRoot
 * @returns {TestFileIndex}
 */
function createTestFileIndex (repoRoot) {
  // `glob` decides case sensitivity from the platform's filesystem; read it back rather than
  // re-deriving it here, so the index cannot drift from the walker it replaces.
  const probe = new Glob(TEST_FILE_GLOB, { cwd: repoRoot, windowsPathsNoEscape: true })

  const files = walkTestFiles(repoRoot)
  files.sort((a, b) => a.localeCompare(b, 'en'))

  return new TestFileIndex(files, { nocase: probe.nocase, platform: probe.platform })
}

module.exports = { TEST_FILE_GLOB, TestFileIndex, createTestFileIndex }
