'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { globSync } = require('glob')

const { TEST_FILE_GLOB, TestFileIndex, createTestFileIndex } = require('./test-file-index')

const REPO_ROOT = path.resolve(__dirname, '..', '..')

const DEFAULT_IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/coverage/**',
  '**/.git/**',
  '**/.nyc_output/**',
  '**/.junit-tmp/**',
  'vendor/dist/**',
]
const NODE_MODULES_ONLY = ['**/node_modules/**']

const FIXTURE_FILES = [
  'a.spec.js',
  'b.test.js',
  'c.spec.mjs',
  'd.test.mjs',
  'e.spec.cjs',
  'f.test.cjs',
  'plain.js',
  'notspec.js',
  'wrong.spec.jsx',
  'wrong.spec.ts',
  '.hidden.spec.js',
  '.hiddendir/inner.spec.js',
  'node_modules/pkg/dep.spec.js',
  'nested/node_modules/deep/dep.spec.js',
  'packages/alpha/test/one.spec.js',
  'packages/alpha/test/deep/two.spec.js',
  'packages/beta/test/three.spec.js',
  'packages/beta/test/integration-test/four.spec.js',
  'packages/datadog-plugin-http/test/index.spec.js',
  'packages/datadog-plugin-redis/test/index.spec.js',
  'vendor/dist/bundled.spec.js',
  'coverage/report.spec.js',
  'sub/dir/with.dots.in.name.spec.js',
  'sub/dir/UPPER.SPEC.JS',
  'integration-tests/one.spec.js',
  'integration-tests/nested/two.spec.js',
]

const FIXTURE_PATTERNS = [
  TEST_FILE_GLOB,
  '**/*.spec.js',
  '**/*.test.js',
  '*.spec.js',
  'packages/*/test/*.spec.js',
  'packages/*/test/**/*.spec.js',
  'packages/**/*.spec.js',
  'packages/alpha/test/one.spec.js',
  'packages/alpha/test/**/*.@(spec|test).@(js|mjs|cjs)',
  'packages/datadog-plugin-@(http|redis)/test/**/*.spec.js',
  'packages/datadog-plugin-@(http)/test/**/*.spec.js',
  'packages/datadog-plugin-*/test/**/*.spec.js',
  'packages/{alpha,beta}/test/**/*.spec.js',
  'packages/{alpha}/test/**/*.spec.js',
  'integration-tests/*.spec.js',
  'integration-tests/**/*.spec.js',
  'sub/dir/*.spec.js',
  'sub/dir/with.dots.in.name.spec.js',
  'vendor/dist/*.spec.js',
  'coverage/*.spec.js',
  '**/node_modules/**/*.spec.js',
  '.hiddendir/*.spec.js',
  'does/not/exist/*.spec.js',
  'packages/*/test/**/**.spec.js',
  '**/*.@(spec|test).@(js|mjs|cjs)',
  '**/*.{spec,test}.js',
  'packages/?????/test/*.spec.js',
  'packages/[ab]*/test/*.spec.js',
  './packages/alpha/test/*.spec.js',
  './/packages/alpha/test/*.spec.js',
  '././packages/alpha/test/*.spec.js',
  'packages/./alpha/test/*.spec.js',
  'packages/alpha/test/',
  '',
]

/**
 * @param {string} root
 * @param {string[]} files
 */
function writeFixture (root, files) {
  for (const file of files) {
    const full = path.join(root, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, '')
  }
}

/**
 * The index deliberately holds only test-named files outside `node_modules`. Expectations are
 * intersected with that same set so a pattern selecting other files is compared fairly.
 *
 * @param {string} root
 * @returns {Set<string>}
 */
function indexableFiles (root) {
  return new Set(globSync(TEST_FILE_GLOB, {
    cwd: root,
    nodir: true,
    windowsPathsNoEscape: true,
    ignore: NODE_MODULES_ONLY,
  }))
}

/**
 * @param {string} root
 * @param {Set<string>} indexable
 * @param {string} pattern
 * @param {string[]} [ignore]
 * @returns {string[]}
 */
function globExpectation (root, indexable, pattern, ignore) {
  return globSync(pattern, { cwd: root, nodir: true, windowsPathsNoEscape: true, ignore })
    .filter(file => indexable.has(file))
    .sort((a, b) => a.localeCompare(b, 'en'))
}

/**
 * @param {Record<string, string>} scripts
 * @returns {string[]}
 */
function globTokensFromScripts (scripts) {
  const tokens = new Set()

  for (const command of Object.values(scripts)) {
    if (typeof command !== 'string') continue

    for (const raw of command.split(/\s+/)) {
      const unquoted = raw.replaceAll(/^["']+|["']+$/g, '')
      if (!unquoted.includes('/') || !/[*?[\]{}()]/.test(unquoted)) continue

      tokens.add(unquoted.replaceAll(/\$\{[^}]+\}/g, '*').replaceAll(/\$[A-Za-z_][A-Za-z0-9_]*/g, '*'))
    }
  }

  return [...tokens]
}

describe('test-file-index', () => {
  /** @type {string} */
  let root
  /** @type {ReturnType<typeof createTestFileIndex>} */
  let index
  /** @type {Set<string>} */
  let indexable

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-file-index-'))
    writeFixture(root, FIXTURE_FILES)
    fs.symlinkSync(path.join(root, 'packages', 'alpha', 'test'), path.join(root, 'linked-tests'), 'dir')

    index = createTestFileIndex(root)
    indexable = indexableFiles(root)
  })

  after(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  describe('inventory', () => {
    it('indexes every supported test-file extension', () => {
      assert.deepStrictEqual(
        index.files.filter(file => !file.includes('/')),
        ['a.spec.js', 'b.test.js', 'c.spec.mjs', 'd.test.mjs', 'e.spec.cjs', 'f.test.cjs']
      )
    })

    it('excludes files that are not named like a test', () => {
      for (const file of ['plain.js', 'notspec.js', 'wrong.spec.jsx', 'wrong.spec.ts']) {
        assert.ok(!index.files.includes(file), `${file} should not be indexed`)
      }
    })

    it('excludes node_modules at any depth', () => {
      for (const file of index.files) {
        assert.ok(!file.includes('node_modules/'), `${file} should not be indexed`)
      }
    })

    it('excludes dot files and dot directories', () => {
      for (const file of index.files) {
        assert.ok(!file.split('/').some(segment => segment.startsWith('.')), `${file} should not be indexed`)
      }
    })

    it('does not descend into symlinked directories', () => {
      assert.ok(!index.files.some(file => file.startsWith('linked-tests/')))
    })

    it('returns sorted repository-relative POSIX paths', () => {
      assert.deepStrictEqual(index.files, [...index.files].sort((a, b) => a.localeCompare(b, 'en')))
      assert.ok(index.files.every(file => !file.startsWith('/') && !file.includes('\\')))
    })

    it('indexes an empty directory as no files', () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-file-index-empty-'))
      try {
        assert.deepStrictEqual(createTestFileIndex(empty).files, [])
      } finally {
        fs.rmSync(empty, { recursive: true, force: true })
      }
    })

    it('warns instead of silently shrinking the index when a directory cannot be read', () => {
      const { write } = process.stderr
      /** @type {string[]} */
      const warnings = []
      process.stderr.write = chunk => warnings.push(String(chunk))

      try {
        assert.deepStrictEqual(createTestFileIndex(path.join(os.tmpdir(), 'dd-test-file-index-missing')).files, [])
      } finally {
        process.stderr.write = write
      }

      assert.deepStrictEqual(warnings, ['test-file-index: skipped unreadable . (ENOENT)\n'])
    })
  })

  describe('matching', () => {
    for (const pattern of FIXTURE_PATTERNS) {
      it(`matches globSync for ${pattern}`, () => {
        assert.deepStrictEqual(index.match(pattern), globExpectation(root, indexable, pattern))
      })
    }

    for (const pattern of FIXTURE_PATTERNS) {
      it(`matches globSync for ${pattern} under the default ignore list`, () => {
        assert.deepStrictEqual(
          index.match(pattern, DEFAULT_IGNORE_GLOBS),
          globExpectation(root, indexable, pattern, DEFAULT_IGNORE_GLOBS)
        )
      })
    }

    it('matches globSync for every glob token in the real package.json', () => {
      const { scripts } = require(path.join(REPO_ROOT, 'package.json'))
      const repoIndex = createTestFileIndex(REPO_ROOT)
      const repoIndexable = indexableFiles(REPO_ROOT)
      const patterns = globTokensFromScripts(scripts)

      assert.ok(patterns.length > 20, `expected a representative corpus, got ${patterns.length}`)

      for (const pattern of patterns) {
        assert.deepStrictEqual(
          repoIndex.match(pattern, DEFAULT_IGNORE_GLOBS),
          globExpectation(REPO_ROOT, repoIndexable, pattern, DEFAULT_IGNORE_GLOBS),
          `pattern ${pattern} diverged from globSync`
        )
      }
    })

    it('matches globSync for the repository-wide test glob', () => {
      const repoIndex = createTestFileIndex(REPO_ROOT)

      assert.deepStrictEqual(
        repoIndex.match(TEST_FILE_GLOB, DEFAULT_IGNORE_GLOBS),
        globSync(TEST_FILE_GLOB, {
          cwd: REPO_ROOT,
          nodir: true,
          windowsPathsNoEscape: true,
          ignore: DEFAULT_IGNORE_GLOBS,
        }).sort((a, b) => a.localeCompare(b, 'en'))
      )
    })
  })

  describe('ignore lists', () => {
    it('drops paths excluded by the default ignore list', () => {
      const matched = index.match('**/*.spec.js', DEFAULT_IGNORE_GLOBS)

      assert.ok(!matched.includes('vendor/dist/bundled.spec.js'))
      assert.ok(!matched.includes('coverage/report.spec.js'))
      assert.ok(matched.includes('packages/alpha/test/one.spec.js'))
    })

    it('keeps paths a narrower ignore list allows', () => {
      const matched = index.match('**/*.spec.js', NODE_MODULES_ONLY)

      assert.ok(matched.includes('vendor/dist/bundled.spec.js'))
      assert.ok(matched.includes('coverage/report.spec.js'))
    })

    it('treats an empty ignore list as no filtering', () => {
      assert.deepStrictEqual(index.match('**/*.spec.js'), index.match('**/*.spec.js', []))
    })

    it('keeps results for the same pattern independent per ignore list', () => {
      const wide = index.match('**/*.spec.js', NODE_MODULES_ONLY)
      const narrow = index.match('**/*.spec.js', DEFAULT_IGNORE_GLOBS)

      assert.ok(wide.length > narrow.length)
      assert.deepStrictEqual(index.match('**/*.spec.js', NODE_MODULES_ONLY), wide)
    })
  })

  describe('platform semantics', () => {
    // `glob` reads case sensitivity off the filesystem, so a run on one platform never exercises
    // the other's rules. Both are pinned here, independent of the host this suite runs on.
    const files = ['sub/dir/lower.spec.js', 'sub/dir/UPPER.SPEC.JS']
    const platforms = [
      { platform: 'darwin', nocase: true },
      { platform: 'win32', nocase: true },
      { platform: 'linux', nocase: false },
    ]
    const caseInsensitivePlatforms = platforms.filter(entry => entry.nocase)

    it('matches a wildcard segment case-insensitively where the filesystem is', () => {
      for (const { platform } of caseInsensitivePlatforms) {
        assert.deepStrictEqual(new TestFileIndex(files, { nocase: true, platform }).match('sub/dir/*.spec.js'),
          files, `platform ${platform}`)
      }
    })

    it('matches a wildcard segment case-sensitively on linux', () => {
      const index = new TestFileIndex(files, { nocase: false, platform: 'linux' })
      assert.deepStrictEqual(index.match('sub/dir/*.spec.js'), ['sub/dir/lower.spec.js'])
    })

    it('rejects a literal segment whose case differs, on every platform', () => {
      for (const { platform, nocase } of platforms) {
        assert.deepStrictEqual(new TestFileIndex(files, { nocase, platform }).match('sub/dir/upper.spec.js'),
          [], `platform ${platform}`)
      }
    })

    it('throws on a pattern it cannot resolve rather than matching too few files', () => {
      const index = new TestFileIndex(files, { nocase: false, platform: 'linux' })
      const expected = { message: /cannot resolve the '\.\.' segment/ }

      assert.throws(() => index.match('packages/../sub/dir/lower.spec.js'), expected)
      assert.throws(() => index.match('../sub/*.spec.js'), expected)
      assert.throws(() => index.match('sub/..'), expected)
      assert.deepStrictEqual(index.match('sub/dir/with..dots.spec.js'), [])
    })
  })

  describe('repeated queries', () => {
    it('returns equal results when a pattern is matched twice', () => {
      for (const pattern of ['**/*.spec.js', 'packages/*/test/**/*.spec.js', 'does/not/exist/*.spec.js']) {
        assert.deepStrictEqual(index.match(pattern, DEFAULT_IGNORE_GLOBS), index.match(pattern, DEFAULT_IGNORE_GLOBS))
      }
    })

    it('does not leak matches between patterns sharing a literal prefix', () => {
      const one = index.match('packages/alpha/test/one.spec.js')
      const deep = index.match('packages/alpha/test/deep/*.spec.js')

      assert.deepStrictEqual(one, ['packages/alpha/test/one.spec.js'])
      assert.deepStrictEqual(deep, ['packages/alpha/test/deep/two.spec.js'])
    })
  })
})
