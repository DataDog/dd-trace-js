const {
  createSandbox,
  spawnProc
} = require('./helpers')
const { assert } = require('chai')
const path = require('path')

const DD_INJECTION_ENABLED = 'tracing'

let cwd, proc, sandbox

async function runTest (cwd, file, env, expected) {
  return new Promise((resolve, reject) => {
    spawnProc(path.join(cwd, file), { cwd, env, silent: true }, data => {
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

function testInjectionScenarios (arg, filename, esmWorks = false) {
  context('when dd-trace is not in the app dir', () => {
    const NODE_OPTIONS = `--no-warnings --${arg} ${path.join(__dirname, '..', filename)}`
    it('should initialize the tracer, if no DD_INJECTION_ENABLED', () => {
      return runTest(cwd, 'init/trace.js', { NODE_OPTIONS }, 'true\n')
    })
    it('should not initialize the tracer, if DD_INJECTION_ENABLED', () => {
      return runTest(cwd, 'init/trace.js', { NODE_OPTIONS, DD_INJECTION_ENABLED }, 'false\n')
    })
    it('should initialize instrumentation, if no DD_INJECTION_ENABLED', () => {
      return runTest(cwd, 'init/instrument.js', { NODE_OPTIONS }, 'true\n')
    })
    it('should not initialize instrumentation, if DD_INJECTION_ENABLED', () => {
      return runTest(cwd, 'init/instrument.js', { NODE_OPTIONS, DD_INJECTION_ENABLED }, 'false\n')
    })
    it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation, if no DD_INJECTION_ENABLED`, () => {
      return runTest(cwd, 'init/instrument.mjs', { NODE_OPTIONS }, `${esmWorks}\n`)
    })
    it('should not initialize ESM instrumentation, if DD_INJECTION_ENABLED', () => {
      return runTest(cwd, 'init/instrument.mjs', { NODE_OPTIONS, DD_INJECTION_ENABLED }, 'false\n')
    })
  })
  context('when dd-trace in the app dir', () => {
    const NODE_OPTIONS = `--no-warnings --${arg} dd-trace/${filename}`
    it('should initialize the tracer, if no DD_INJECTION_ENABLED', () => {
      return runTest(cwd, 'init/trace.js', { NODE_OPTIONS }, 'true\n')
    })
    it('should initialize the tracer, if DD_INJECTION_ENABLED', () => {
      return runTest(cwd, 'init/trace.js', { NODE_OPTIONS, DD_INJECTION_ENABLED }, 'true\n')
    })
    it('should initialize instrumentation, if no DD_INJECTION_ENABLED', () => {
      return runTest(cwd, 'init/instrument.js', { NODE_OPTIONS }, 'true\n')
    })
    it('should initialize instrumentation, if DD_INJECTION_ENABLED', () => {
      return runTest(cwd, 'init/instrument.js', { NODE_OPTIONS, DD_INJECTION_ENABLED }, 'true\n')
    })
    it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation, if no DD_INJECTION_ENABLED`, () => {
      return runTest(cwd, 'init/instrument.mjs', { NODE_OPTIONS }, `${esmWorks}\n`)
    })
    it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation, if DD_INJECTION_ENABLED`, () => {
      return runTest(cwd, 'init/instrument.mjs', { NODE_OPTIONS, DD_INJECTION_ENABLED }, `${esmWorks}\n`)
    })
  })
}

describe('init.js', () => {
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

  testInjectionScenarios('require', 'init.js', false)
})

describe('initialize.mjs', () => {
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

  context('as --loader', () => {
    testInjectionScenarios('loader', 'initialize.mjs', true)
  })
  context('as --import', () => {
    testInjectionScenarios('import', 'initialize.mjs', true)
  })
})
