'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const util = require('node:util')

const execFileAsync = util.promisify(execFile)
const mochaBin = path.join(__dirname, '../../../node_modules/mocha/bin/mocha.js')
const coreSetupPath = path.join(__dirname, 'setup/core.js')

describe('mocha hooks setup', () => {
  it('suppresses after all errors when a test in the same suite already failed', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        after(() => {
          throw new Error('cleanup failed')
        })

        it('fails for the real reason', () => {
          throw new Error('test failed')
        })
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['test failed'])
  })

  it('suppresses after each errors when the current test already failed', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        afterEach(() => {
          throw new Error('cleanup failed')
        })

        it('fails for the real reason', () => {
          throw new Error('test failed')
        })
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['test failed'])
  })

  it('suppresses after each errors when a before each in the same suite already failed', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        beforeEach(() => {
          throw new Error('setup failed')
        })

        afterEach(() => {
          throw new Error('cleanup failed')
        })

        it('does something', () => {})
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['setup failed'])
  })

  it('suppresses outer after all errors when a nested test already failed', async () => {
    const result = await runFixture(`
      describe('outer suite', () => {
        after(() => {
          throw new Error('outer cleanup failed')
        })

        describe('inner suite', () => {
          it('fails for the real reason', () => {
            throw new Error('inner test failed')
          })
        })
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['inner test failed'])
  })

  it('suppresses outer after each errors when a nested before each already failed', async () => {
    const result = await runFixture(`
      describe('outer suite', () => {
        afterEach(() => {
          throw new Error('outer cleanup failed')
        })

        describe('inner suite', () => {
          beforeEach(() => {
            throw new Error('inner setup failed')
          })

          it('does something', () => {})
        })
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['inner setup failed'])
  })

  it('suppresses outer after each errors when a nested after each already failed', async () => {
    const result = await runFixture(`
      describe('outer suite', () => {
        afterEach(() => {
          throw new Error('outer cleanup failed')
        })

        describe('inner suite', () => {
          afterEach(() => {
            throw new Error('inner cleanup failed')
          })

          it('passes before cleanup', () => {})
        })
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['inner cleanup failed'])
  })
})

/**
 * @param {string} body
 * @returns {Promise<MochaJsonResult>}
 */
async function runFixture (body) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-mocha-hooks-'))
  const fixture = path.join(tmpdir, 'fixture.spec.js')
  fs.writeFileSync(fixture, `'use strict'

require(${JSON.stringify(coreSetupPath)})

${body}
`)

  try {
    const { stdout } = await execFileMocha(fixture)
    return JSON.parse(stdout)
  } finally {
    fs.rmSync(tmpdir, { force: true, recursive: true })
  }
}

/**
 * @param {string} fixture
 * @returns {Promise<{ stdout: string }>}
 */
async function execFileMocha (fixture) {
  try {
    return await execFileAsync(process.execPath, [mochaBin, '--no-config', '--reporter', 'json', fixture])
  } catch (err) {
    if (!err || typeof err !== 'object' || !('stdout' in err) || typeof err.stdout !== 'string') throw err
    return { stdout: err.stdout }
  }
}

/**
 * @param {MochaJsonResult} result
 * @returns {string[]}
 */
function getFailureMessages (result) {
  return result.failures.map(failure => failure.err.message)
}
