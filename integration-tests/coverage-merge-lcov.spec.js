'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { convertV8DirToReport } = require('./coverage/merge-lcov')
const { REPO_ROOT } = require('./coverage/runtime')

// A real in-scope repo source. Integration tests exercise this file inside a sandbox, so its V8
// coverage arrives keyed at the sandbox path; the rebase has to fold it back onto this repo path.
const REPO_REL = path.join('packages', 'datadog-plugin-jest', 'src', 'index.js')
const REPO_FILE = path.join(REPO_ROOT, REPO_REL)

/** @typedef {import('node:inspector').Profiler.ScriptCoverage} ScriptCoverage */

/**
 * @typedef {object} IstanbulFileCoverage
 * @property {string} path
 * @property {Record<string, number>} s
 * @property {Record<string, number[]>} b
 * @property {Record<string, { name: string }>} fnMap
 * @property {Record<string, number>} f
 */

/**
 * One V8 script entry whose single function range spans the whole file, marking every executed
 * line as hit. Enough to prove the file is counted; the hit values themselves are not asserted.
 *
 * @param {string} sourceUrl `file://` url V8 would have recorded for the script
 * @param {number} endOffset byte length of the source the range covers
 * @param {number} [count]
 * @returns {ScriptCoverage}
 */
function scriptEntry (sourceUrl, endOffset, count = 1) {
  return {
    scriptId: '0',
    url: sourceUrl,
    functions: [
      { functionName: '', isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset, count }] },
    ],
  }
}

/**
 * @param {string} sourceUrl
 * @param {number} endOffset
 * @param {number} branchCount
 * @returns {ScriptCoverage}
 */
function blockEntry (sourceUrl, endOffset, branchCount) {
  return {
    scriptId: '0',
    url: sourceUrl,
    functions: [{
      functionName: '',
      isBlockCoverage: true,
      ranges: [
        { startOffset: 0, endOffset, count: 1 },
        { startOffset: 10, endOffset: 20, count: branchCount },
      ],
    }],
  }
}

/**
 * @param {string} sourceUrl
 * @param {number} endOffset
 * @returns {ScriptCoverage}
 */
function functionEntry (sourceUrl, endOffset) {
  return {
    scriptId: '0',
    url: sourceUrl,
    functions: [{
      functionName: 'coveredFunction',
      isBlockCoverage: false,
      ranges: [{ startOffset: 0, endOffset, count: 1 }],
    }],
  }
}

describe('integration coverage merge', () => {
  let workDir, v8Dir, outputDir, sourceLength

  before(async () => {
    sourceLength = (await fs.readFile(REPO_FILE, 'utf8')).length
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-merge-lcov-'))
    v8Dir = path.join(workDir, 'v8')
    outputDir = path.join(workDir, 'report')
  })

  after(() => fs.rm(workDir, { force: true, recursive: true }))

  /**
   * Write each `result` as one process profile, convert them, and return both the run summary and the
   * parsed coverage map (empty object when the run produced no files).
   *
   * @param {...ScriptCoverage[]} results V8 `result` entries to write as process profiles
   * @returns {Promise<{
   *   summary: { scripts: number, profiles: number, files: number },
   *   coverage: Record<string, IstanbulFileCoverage>
   * }>}
   */
  async function convert (...results) {
    await fs.rm(v8Dir, { force: true, recursive: true })
    await fs.rm(outputDir, { force: true, recursive: true })
    await fs.mkdir(v8Dir, { recursive: true })
    for (let i = 0; i < results.length; i++) {
      await fs.writeFile(path.join(v8Dir, `profile-${i}.json`), JSON.stringify({ result: results[i] }))
    }
    const summary = await convertV8DirToReport(v8Dir, outputDir)
    let coverage = {}
    if (summary.files > 0) {
      coverage = JSON.parse(await fs.readFile(path.join(outputDir, 'coverage-final.json'), 'utf8'))
    }
    return { summary, coverage }
  }

  it('rebases sandbox dd-trace coverage onto the repo path', async () => {
    // The sandbox is gone by merge time, so the url points at a directory that no longer exists.
    const sandboxFile = path.join(
      os.tmpdir(), 'deleted-sandbox', '1234', 'node_modules', 'dd-trace', REPO_REL
    )
    const { coverage } = await convert([scriptEntry(pathToFileURL(sandboxFile).href, sourceLength)])

    assert.ok(coverage[REPO_FILE], `expected coverage keyed at repo path ${REPO_FILE}`)
    assert.equal(coverage[sandboxFile], undefined, 'sandbox path must not survive into the report')
  })

  it('counts coverage already keyed at the repo path unchanged', async () => {
    const { coverage } = await convert([scriptEntry(pathToFileURL(REPO_FILE).href, sourceLength)])

    assert.ok(coverage[REPO_FILE], 'repo-pathed entry should be counted as-is')
  })

  it('merges execution counts from repository and sandbox profiles', async () => {
    const sandboxFile = path.join(
      os.tmpdir(), 'deleted-sandbox', '1234', 'node_modules', 'dd-trace', REPO_REL
    )
    const { summary, coverage } = await convert(
      [scriptEntry(pathToFileURL(REPO_FILE).href, sourceLength, 2)],
      [scriptEntry(pathToFileURL(sandboxFile).href, sourceLength, 3)]
    )

    assert.deepStrictEqual(summary, { scripts: 2, profiles: 2, files: 1 })
    assert.ok(Object.values(coverage[REPO_FILE].s).every(count => count === 5))
  })

  it('merges count-independent defaults from partially covered profiles', async () => {
    const sourceUrl = pathToFileURL(REPO_FILE).href
    const { coverage } = await convert(
      [scriptEntry(sourceUrl, 20, 2)],
      [scriptEntry(sourceUrl, 20, 3)]
    )

    const statementCounts = Object.values(coverage[REPO_FILE].s)
    assert.ok(statementCounts.includes(5))
    assert.ok(statementCounts.includes(2))
  })

  it('merges nested block ranges from multiple profiles', async () => {
    const sourceUrl = pathToFileURL(REPO_FILE).href
    const { coverage } = await convert(
      [blockEntry(sourceUrl, sourceLength, 0)],
      [blockEntry(sourceUrl, sourceLength, 1)]
    )

    const branchCounts = Object.values(coverage[REPO_FILE].b).flat().sort((countA, countB) => countA - countB)
    assert.deepStrictEqual(branchCounts, [1, 2])
  })

  it('preserves distinct function and block coverage shapes', async () => {
    const sourceUrl = pathToFileURL(REPO_FILE).href
    const { coverage } = await convert(
      [functionEntry(sourceUrl, sourceLength)],
      [functionEntry(sourceUrl, sourceLength)],
      [blockEntry(sourceUrl, sourceLength, 1)]
    )

    const functionMapEntry = Object.entries(coverage[REPO_FILE].fnMap)
      .find(([, { name }]) => name === 'coveredFunction')
    assert.ok(functionMapEntry)
    assert.strictEqual(coverage[REPO_FILE].f[functionMapEntry[0]], 2)
    assert.deepStrictEqual(Object.values(coverage[REPO_FILE].b).flat(), [1, 1])
  })

  it('ignores malformed profiles and entries', async () => {
    await fs.rm(v8Dir, { force: true, recursive: true })
    await fs.rm(outputDir, { force: true, recursive: true })
    await fs.mkdir(v8Dir, { recursive: true })
    await fs.writeFile(path.join(v8Dir, 'malformed.json'), '{')
    await fs.writeFile(path.join(v8Dir, 'invalid-entries.json'), JSON.stringify({
      result: [
        {},
        { url: 'node:internal/test', functions: [] },
        { url: pathToFileURL(REPO_FILE).href, functions: undefined },
      ],
    }))

    const summary = await convertV8DirToReport(v8Dir, outputDir)

    assert.deepStrictEqual(summary, { scripts: 0, profiles: 2, files: 0 })
  })

  it('skips source files that cannot be loaded', async () => {
    const missingFile = path.join(REPO_ROOT, 'packages', 'dd-trace', 'src', 'missing-coverage-source.js')
    const { summary } = await convert([scriptEntry(pathToFileURL(missingFile).href, 10)])

    assert.deepStrictEqual(summary, { scripts: 0, profiles: 1, files: 0 })
  })

  it('still drops coverage for unrelated dependencies', async () => {
    const depFile = path.join(
      os.tmpdir(), 'deleted-sandbox', '1234', 'node_modules', 'some-other-dep', 'index.js'
    )
    const { summary } = await convert([scriptEntry(pathToFileURL(depFile).href, 10)])

    assert.equal(summary.files, 0, 'unrelated dependency coverage should be filtered out')
  })
})
