import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, it } from 'mocha'

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const checkerPath = join(repositoryDirectory, 'scripts', 'type-check.js')

/**
 * @param {string[]} args
 */
function runChecker (args) {
  return spawnSync(process.execPath, [checkerPath, ...args], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
  })
}

describe('type-check', () => {
  let temporaryDirectory

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'dd-trace-type-check-'))
    writeFileSync(join(temporaryDirectory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, strict: true, types: [] },
      include: ['included.js'],
    }))
    writeFileSync(join(temporaryDirectory, 'imported.js'), [
      '/** @type {number} */',
      "module.exports = 'not a number'",
      '',
    ].join('\n'))
  })

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  /**
   * @param {string} content
   */
  function writeIncluded (content) {
    writeFileSync(join(temporaryDirectory, 'included.js'), content)
  }

  it('ignores errors in files that the included files import', () => {
    writeIncluded("require('./imported')\n")

    const result = runChecker([join(temporaryDirectory, 'tsconfig.json')])

    assert.strictEqual(result.status, 0, result.stdout)
    assert.strictEqual(result.stdout, '')
  })

  it('reports errors in the included files', () => {
    writeIncluded("require('./imported')\n/** @type {string} */\nconst value = 1\nmodule.exports = value\n")

    const result = runChecker([join(temporaryDirectory, 'tsconfig.json')])

    assert.strictEqual(result.status, 1)
    assert.match(result.stdout, /included\.js\(3,7\): error TS2322: Type 'number' is not assignable to type 'string'\./)
    assert.doesNotMatch(result.stdout, /imported\.js/)
    assert.match(result.stdout, /Found 1 type error\(s\)\./)
  })

  it('reports a config file that cannot be read', () => {
    const result = runChecker([join(temporaryDirectory, 'missing.json')])

    assert.strictEqual(result.status, 1)
    assert.match(result.stdout, /error TS5083: Cannot read file '.*missing\.json'\./)
  })

  it('requires a config file argument', () => {
    const result = runChecker([])

    assert.strictEqual(result.status, 2)
    assert.strictEqual(result.stderr, 'Usage: node scripts/type-check.js <tsconfig>\n')
  })
})
