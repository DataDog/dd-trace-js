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
    const cleanup = []
    if (childProcess !== undefined) cleanup.push(stopProc(childProcess))
    if (agent !== undefined) cleanup.push(agent.stop())
    await Promise.all(cleanup)
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
      let requestSpan
      for (const trace of payload) {
        for (const span of trace) {
          if (span.name === 'source-map.request') {
            requestSpan = span
            break
          }
        }
        if (requestSpan !== undefined) break
      }
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

  it('maps only the exported error span stack by default', async function () {
    await startApp()

    const [errorStack, applicationStack] = await Promise.all([
      requestErrorStack(),
      requestApplicationStack(),
    ])

    assert.match(errorStack, /throws\.ts:7:/)
    assert.doesNotMatch(errorStack, /throws\.js:/)
    assert.match(applicationStack, /throws\.js:6:/)
    assert.doesNotMatch(applicationStack, /throws\.ts:/)
  })

  it('leaves both stack representations generated in off mode', async function () {
    await startApp({ DD_TRACE_SOURCE_MAPS_MODE: 'off' })

    const [errorStack, applicationStack] = await Promise.all([
      requestErrorStack(),
      requestApplicationStack(),
    ])

    assert.match(errorStack, /throws\.js:6:/)
    assert.doesNotMatch(errorStack, /throws\.ts:/)
    assert.match(applicationStack, /throws\.js:6:/)
    assert.doesNotMatch(applicationStack, /throws\.ts:/)
  })

  it('maps both stack representations in all mode', async function () {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    if (typeof Module.setSourceMapsSupport !== 'function') this.skip()
    await startApp({ DD_TRACE_SOURCE_MAPS_MODE: 'all' })

    const [errorStack, applicationStack] = await Promise.all([
      requestErrorStack(),
      requestApplicationStack(),
    ])

    assert.match(errorStack, /throws\.ts:7:/)
    assert.doesNotMatch(errorStack, /throws\.js:/)
    assert.match(applicationStack, /throws\.ts:7:/)
    assert.doesNotMatch(applicationStack, /throws\.js:/)
  })

  it('defers to source maps enabled by Node', async function () {
    await startApp({ NODE_OPTIONS: '--enable-source-maps' })

    const [errorStack, applicationStack] = await Promise.all([
      requestErrorStack(),
      requestApplicationStack(),
    ])

    assert.match(errorStack, /throws\.ts:7:/)
    assert.doesNotMatch(errorStack, /throws\.js:/)
    assert.match(applicationStack, /throws\.ts:7:/)
    assert.doesNotMatch(applicationStack, /throws\.js:/)
  })
})
