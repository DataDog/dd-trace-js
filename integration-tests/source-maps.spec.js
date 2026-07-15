'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const Axios = require('axios')

const { FakeAgent, sandboxCwd, spawnProc, stopProc, useSandbox } = require('./helpers')

describe('source map support', function () {
  let agent
  let appFile
  let axios
  let childProcess
  let workingDirectory

  useSandbox()

  before(function () {
    workingDirectory = sandboxCwd()
    appFile = path.join(workingDirectory, 'source-maps', 'index.js')
  })

  afterEach(async function () {
    await Promise.all([
      childProcess === undefined ? undefined : stopProc(childProcess),
      agent?.stop(),
    ])
    agent = undefined
    childProcess = undefined
  })

  /**
   * @param {Record<string, string>} [environment]
   * @returns {Promise<void>}
   */
  async function startApp (environment = {}) {
    agent = await new FakeAgent().start()
    childProcess = await spawnProc(appFile, {
      cwd: workingDirectory,
      env: {
        _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
        DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`,
        DD_TRACE_FLUSH_INTERVAL: '0',
        ...(process.env.DD_INJECT_FORCE === undefined ? {} : { DD_INJECT_FORCE: process.env.DD_INJECT_FORCE }),
        ...environment,
      },
      stdio: 'pipe',
    })
    axios = Axios.create({ baseURL: childProcess.url })
  }

  /**
   * @returns {Promise<string>}
   */
  async function requestErrorStack () {
    let stack
    /**
     * @param {{
     *   payload: Array<Array<{ error: number, meta: Record<string, string>, name: string }>>
     * }} message
     */
    function assertErrorSpan ({ payload }) {
      const requestSpan = payload.flat().find(span => span.name === 'source-map.request')
      assert.ok(requestSpan, 'source-map.request span should be present')
      assert.strictEqual(requestSpan.error, 1)
      stack = requestSpan.meta['error.stack']
    }
    const [, response] = await Promise.all([
      agent.assertMessageReceived(assertErrorSpan),
      axios.get('/', { validateStatus: () => true }),
    ])
    assert.strictEqual(response.status, 500)
    assert.strictEqual(typeof stack, 'string')
    return stack
  }

  /**
   * @returns {Promise<string>}
   */
  async function requestApplicationStack () {
    const response = await axios.get('/stack')
    assert.strictEqual(response.status, 200)
    assert.strictEqual(typeof response.data.stack, 'string')
    return response.data.stack
  }

  /**
   * @param {string} stack
   * @param {string} source
   */
  function assertStackSource (stack, source) {
    const generated = source.startsWith('throws.js')
    assert.match(stack, new RegExp(`${source.replace('.', '\\.')}:`))
    assert.doesNotMatch(stack, generated ? /throws\.ts:/ : /throws\.js:/)
  }

  /** @type {Array<[string, Record<string, string>, string, string, boolean]>} */
  const cases = [
    ['maps only the exported error span stack by default', {}, 'throws.ts:7', 'throws.js:6', false],
    ['leaves both stack representations generated in off mode',
      { DD_TRACE_SOURCE_MAPS_MODE: 'off' }, 'throws.js:6', 'throws.js:6', false],
    ['maps both stack representations in all mode',
      { DD_TRACE_SOURCE_MAPS_MODE: 'all' }, 'throws.ts:7', 'throws.ts:7', true],
    ['defers to source maps enabled by Node',
      { NODE_OPTIONS: '--enable-source-maps' }, 'throws.ts:7', 'throws.ts:7', false],
  ]

  for (const [name, environment, errorSource, applicationSource, requiresProgrammaticSupport] of cases) {
    it(name, async function () {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      if (requiresProgrammaticSupport && typeof Module.setSourceMapsSupport !== 'function') this.skip()
      await startApp(environment)

      const [errorStack, applicationStack] = await Promise.all([
        requestErrorStack(),
        requestApplicationStack(),
      ])

      assertStackSource(errorStack, errorSource)
      assertStackSource(applicationStack, applicationSource)
    })
  }
})
