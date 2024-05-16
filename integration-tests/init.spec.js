const {
  createSandbox,
  spawnProc
} = require('./helpers')
const { assert } = require('chai')
const path = require('path')

const DD_INJECTION_ENABLED = 'tracing'

describe('init.js', () => {
  let cwd, proc, sandbox

  async function runTest (cwd, env, expected) {
    return new Promise((resolve, reject) => {
      spawnProc(path.join(cwd, 'init/index.js'), { cwd, env }, data => {
        try {
          assert.strictEqual(data.toString(), expected)
          resolve()
        } catch (e) {
          reject(e)
        }
      }).then(subproc => {
        proc = subproc
      })
    })
  }

  before(async () => {
    sandbox = await createSandbox()
    cwd = sandbox.folder
  })
  afterEach(() => {
    proc && proc.kill()
  })
  after(() => {
    return sandbox.remove()
  })

  context('when dd-trace is not in the app dir', () => {
    const NODE_OPTIONS = `--require ${path.join(__dirname, '..', 'init.js')}`
    it('should initialize the tracer, if no DD_INJECTION_ENABLED', () => {
      return runTest(cwd, { NODE_OPTIONS }, 'true\n')
    })
    it('should not initialize the tracer, if DD_INJECTION_ENABLED', () => {
      return runTest(cwd, { NODE_OPTIONS, DD_INJECTION_ENABLED }, 'false\n')
    })
  })
  context('when dd-trace in the app dir', () => {
    const NODE_OPTIONS = '--require dd-trace/init.js'
    it('should initialize the tracer, if no DD_INJECTION_ENABLED', () => {
      return runTest(cwd, { NODE_OPTIONS }, 'true\n')
    })
    it('should initialize the tracer, if DD_INJECTION_ENABLED', () => {
      return runTest(cwd, { NODE_OPTIONS, DD_INJECTION_ENABLED }, 'true\n')
    })
  })
})
