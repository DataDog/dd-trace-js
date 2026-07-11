'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const Axios = require('axios')

const { FakeAgent, sandboxCwd, spawnProc, stopProc, useSandbox } = require('./helpers')

// eslint-disable-next-line n/no-unsupported-features/node-builtins
const describeOrSkip = typeof Module.setSourceMapsSupport === 'function' ? describe : describe.skip

describeOrSkip('source map support without --enable-source-maps', function () {
  let agent
  let appFile
  let axios
  let childProcess
  let workingDirectory

  useSandbox(['fastify'])

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
    function assertFastifyErrorSpan ({ payload }) {
      let requestSpan
      for (const trace of payload) {
        for (const span of trace) {
          if (span.name === 'fastify.request') {
            requestSpan = span
            break
          }
        }
        if (requestSpan !== undefined) break
      }
      assert.ok(requestSpan, 'fastify.request span should be present')
      assert.strictEqual(requestSpan.error, 1)
      stack = requestSpan.meta['error.stack']
    }
    const [, response] = await Promise.all([
      agent.assertMessageReceived(assertFastifyErrorSpan),
      axios.get('/', { validateStatus: () => true }),
    ])
    assert.strictEqual(response.status, 500)
    assert.strictEqual(typeof stack, 'string')
    return stack
  }

  it('maps an error span stack to the original TypeScript source by default', async function () {
    await startApp()

    const stack = await requestErrorStack()

    assert.match(stack, /throws\.ts:4:/)
    assert.doesNotMatch(stack, /throws\.js:/)
  })

  it('can be disabled with DD_TRACE_SOURCE_MAPS_ENABLED', async function () {
    await startApp({ DD_TRACE_SOURCE_MAPS_ENABLED: 'false' })

    const stack = await requestErrorStack()

    assert.match(stack, /throws\.js:5:/)
    assert.doesNotMatch(stack, /throws\.ts:/)
  })
})
