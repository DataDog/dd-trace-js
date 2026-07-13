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

/**
 * One V8 script entry whose single function range spans the whole file, marking every executed
 * line as hit. Enough to prove the file is counted; the hit values themselves are not asserted.
 *
 * @param {string} sourceUrl `file://` url V8 would have recorded for the script
 * @param {number} endOffset byte length of the source the range covers
 * @returns {{ url: string, functions: object[] }}
 */
function scriptEntry (sourceUrl, endOffset) {
  return {
    url: sourceUrl,
    functions: [
      { functionName: '', isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset, count: 1 }] },
    ],
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
   * Write `result` as one process profile, convert it, and return both the run summary and the
   * parsed coverage map (empty object when the run produced no files).
   *
   * @param {object[]} result V8 `result` entries to write as one process profile
   * @returns {Promise<{ summary: { files: number }, coverage: Record<string, { path: string }> }>}
   */
  async function convert (result) {
    await fs.rm(v8Dir, { force: true, recursive: true })
    await fs.rm(outputDir, { force: true, recursive: true })
    await fs.mkdir(v8Dir, { recursive: true })
    await fs.writeFile(path.join(v8Dir, 'profile.json'), JSON.stringify({ result }))
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

  it('still drops coverage for unrelated dependencies', async () => {
    const depFile = path.join(
      os.tmpdir(), 'deleted-sandbox', '1234', 'node_modules', 'some-other-dep', 'index.js'
    )
    const { summary } = await convert([scriptEntry(pathToFileURL(depFile).href, 10)])

    assert.equal(summary.files, 0, 'unrelated dependency coverage should be filtered out')
  })
})
