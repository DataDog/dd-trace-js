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
  it('suppresses after all errors when a before all in the same suite already failed', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        let resource

        before(() => {
          throw new Error('setup failed')
        })

        after(() => {
          resource.close()
        })

        it('does something', () => {})
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['setup failed'])
  })

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

  it('continues running tests after suppressing an after each error', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        afterEach(function () {
          if (this.currentTest.title === 'fails for the real reason') {
            throw new Error('cleanup failed')
          }
        })

        it('fails for the real reason', () => {
          throw new Error('test failed')
        })

        it('still runs', () => {})
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['test failed'])
    assert.deepStrictEqual(getPassTitles(result), ['still runs'])
  })

  it('suppresses after each errors when a failed test is retried', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        afterEach(() => {
          throw new Error('cleanup failed')
        })

        it('fails for the real reason', function () {
          this.retries(1)
          throw new Error('test failed')
        })
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['test failed'])
  })

  it('suppresses after all errors when a failed test is retried', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        after(() => {
          throw new Error('cleanup failed')
        })

        it('fails for the real reason', function () {
          this.retries(1)
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

  it('suppresses outer after all errors when a nested before all already failed', async () => {
    const result = await runFixture(`
      describe('outer suite', () => {
        after(() => {
          throw new Error('outer cleanup failed')
        })

        describe('inner suite', () => {
          before(() => {
            throw new Error('inner setup failed')
          })

          it('does something', () => {})
        })
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['inner setup failed'])
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

  it('suppresses promise-returning after each errors after a test failure', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        afterEach(() => {
          return Promise.reject(new Error('cleanup failed'))
        })

        it('fails for the real reason', () => {
          throw new Error('test failed')
        })
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['test failed'])
  })

  it('suppresses callback after each errors after a test failure', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        afterEach((done) => {
          done(new Error('cleanup failed'))
        })

        it('fails for the real reason', () => {
          throw new Error('test failed')
        })
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['test failed'])
  })

  it('suppresses root after all errors after a root test failure', async () => {
    const result = await runFixture(`
      after(() => {
        throw new Error('cleanup failed')
      })

      it('fails for the real reason', () => {
        throw new Error('test failed')
      })
    `)

    assert.deepStrictEqual(getFailureMessages(result), ['test failed'])
  })

  it('does not let a suppressed after each error change bail behavior', async () => {
    const result = await runFixture(`
      describe('suite', () => {
        afterEach(function () {
          if (this.currentTest.title === 'fails for the real reason') {
            throw new Error('cleanup failed')
          }
        })

        it('fails for the real reason', () => {
          throw new Error('test failed')
        })

        it('is skipped by bail', () => {})
      })
    `, ['--bail'])

    assert.deepStrictEqual(getFailureMessages(result), ['test failed'])
    assert.deepStrictEqual(getPassTitles(result), [])
  })
})

/**
 * @param {string} body
 * @returns {Promise<MochaJsonResult>}
 */
async function runFixture (body, args = []) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-mocha-hooks-'))
  const fixture = path.join(tmpdir, 'fixture.spec.js')
  fs.writeFileSync(fixture, `'use strict'

require(${JSON.stringify(coreSetupPath)})

${body}
`)

  try {
    const { stdout } = await execFileMocha(fixture, args)
    return JSON.parse(stdout)
  } finally {
    fs.rmSync(tmpdir, { force: true, recursive: true })
  }
}

/**
 * @param {string} fixture
 * @param {string[]} args
 * @returns {Promise<{ stdout: string }>}
 */
async function execFileMocha (fixture, args) {
  // Keep the fixture runner isolated from this repo's .mocharc.js. The repo config
  // enables allowUncaught and mocha-multi-reporters, while these assertions need
  // plain Mocha behavior with JSON emitted on stdout.
  const mochaArgs = [mochaBin, '--no-config', '--reporter', 'json', ...args, fixture]

  try {
    return await execFileAsync(process.execPath, mochaArgs)
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

function getPassTitles (result) {
  return result.passes.map(pass => pass.title)
}
