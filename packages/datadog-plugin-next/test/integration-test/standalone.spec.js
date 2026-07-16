'use strict'

const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { cpSync, mkdtempSync, rmSync } = require('node:fs')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { setTimeout } = require('node:timers/promises')

const axios = require('axios')
const { describe, it } = require('mocha')

const {
  FakeAgent,
  assertObjectContains,
  curlAndAssertMessage,
  sandboxCwd,
  stopProc,
  useSandbox,
} = require('../../../../integration-tests/helpers')

const commonFixtures = './packages/datadog-plugin-next/test/integration-test/standalone/common/*'
const nextDependencies = ['next@^16', 'react@^19', 'react-dom@^19']
const explicitOptionalDependency = '@datadog/openfeature-node-server'
const tracerOptionalDependencies = [
  '@datadog/libdatadog',
  '@datadog/native-appsec',
  '@datadog/native-iast-taint-tracking',
  '@datadog/native-metrics',
  explicitOptionalDependency,
  '@datadog/pprof',
  '@datadog/wasm-js-rewriter',
  '@opentelemetry/api',
  '@opentelemetry/api-logs',
  'oxc-parser',
]

/**
 * @returns {Promise<number>}
 */
function getAvailablePort () {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', function onListening () {
      const address = server.address()
      assert.notStrictEqual(address, null)
      assert.strictEqual(typeof address, 'object')

      /**
       * @param {Error} [error]
       */
      function onClose (error) {
        if (error) {
          reject(error)
        } else {
          resolve(address.port)
        }
      }

      server.close(onClose)
    })
  })
}

/**
 * @param {string} url
 * @param {import('node:child_process').ChildProcess} childProcess
 * @returns {Promise<void>}
 */
async function waitForServer (url, childProcess) {
  let lastError

  for (let attempt = 0; attempt < 50; attempt++) {
    if (childProcess.exitCode !== null) {
      throw new Error(`Next.js exited before listening with status ${childProcess.exitCode}.`)
    }

    try {
      await axios.get(url)
      return
    } catch (error) {
      lastError = error
      await setTimeout(100)
    }
  }

  throw lastError
}

/**
 * @param {string} artifactPath
 * @param {number} port
 * @param {number} agentPort
 * @param {string} nodeOptions
 * @returns {{
 *   childProcess: import('node:child_process').ChildProcessWithoutNullStreams,
 *   readOutput: () => string
 * }}
 */
function startStandaloneServer (artifactPath, port, agentPort, nodeOptions) {
  const {
    NODE_OPTIONS,
    OTEL_LOGS_EXPORTER,
    OTEL_METRICS_EXPORTER,
    OTEL_TRACES_EXPORTER,
    ...env
  } = process.env

  const childProcess = spawn(process.execPath, ['server.js'], {
    cwd: artifactPath,
    env: {
      ...env,
      DD_TRACE_AGENT_PORT: String(agentPort),
      DD_TRACE_FLUSH_INTERVAL: '0',
      HOSTNAME: '127.0.0.1',
      NODE_OPTIONS: nodeOptions,
      PORT: String(port),
    },
    stdio: 'pipe',
  })

  let output = ''

  /**
   * @param {Buffer} data
   */
  function collectOutput (data) {
    output += data
  }

  childProcess.stdout.on('data', collectOutput)
  childProcess.stderr.on('data', collectOutput)

  return {
    childProcess,
    readOutput: () => output,
  }
}

/**
 * @param {Array<Array<Record<string, unknown>>>} traces
 */
function assertNextTrace (traces) {
  for (const trace of traces) {
    for (const span of trace) {
      if (span.name === 'next.request') {
        assertObjectContains(span, {
          name: 'next.request',
          type: 'web',
          meta: {
            'span.kind': 'server',
            'http.method': 'GET',
            'http.status_code': '200',
            component: 'next',
          },
        })
        return
      }
    }
  }

  assert.fail('Expected a next.request span.')
}

/**
 * @param {{ payload: Array<Array<Record<string, unknown>>> }} message
 */
function assertNextMessage ({ payload }) {
  assertNextTrace(payload)
}

/**
 * @param {string} description
 * @param {string[]} fixturePaths
 * @param {{
 *   applicationPath?: string[],
 *   dependencies?: string[],
 *   nodeOptions?: string,
 *   removeOpenFeaturePeer?: boolean,
 *   removeOptionalDependencies?: boolean,
 *   removeServerRoutes?: boolean,
 *   requestPath?: string,
 *   standaloneOutputPath?: string[],
 *   verifyOpenFeature?: boolean,
 *   verifyOptionalDependencies?: boolean
 * }} [options]
 */
function testStandaloneSetup (description, fixturePaths, options = {}) {
  describe(description, () => {
    let agent
    let artifactRoot
    let childProcess
    let readOutput
    let url

    useSandbox(options.dependencies ?? nextDependencies, false, fixturePaths)

    before(async function () {
      this.timeout(300_000)
      const { NODE_OPTIONS, ...env } = process.env

      if (options.removeServerRoutes) {
        rmSync(path.join(sandboxCwd(), 'app', 'api'), { recursive: true, force: true })
      }

      if (options.removeOptionalDependencies) {
        for (const packageName of tracerOptionalDependencies) {
          rmSync(path.join(sandboxCwd(), 'node_modules', ...packageName.split('/')), {
            recursive: true,
            force: true,
          })
        }
      }

      if (options.removeOpenFeaturePeer || options.removeOptionalDependencies) {
        rmSync(path.join(sandboxCwd(), 'node_modules', '@openfeature', 'server-sdk'), {
          recursive: true,
          force: true,
        })
      }

      execFileSync('npm', ['run', 'build'], {
        cwd: sandboxCwd(),
        env,
        stdio: 'inherit',
      })

      artifactRoot = mkdtempSync(path.join(tmpdir(), 'dd-next-standalone-'))
      const artifactPath = path.join(artifactRoot, 'app')
      const standaloneOutputPath = options.standaloneOutputPath ?? ['.next', 'standalone']
      cpSync(path.join(sandboxCwd(), ...standaloneOutputPath), artifactPath, { recursive: true })
      const applicationPath = path.join(artifactPath, ...(options.applicationPath ?? []))

      if (options.verifyOptionalDependencies) {
        const packageNames = tracerOptionalDependencies.filter(packageName => {
          return options.verifyOpenFeature || packageName !== explicitOptionalDependency
        })
        const script = `for (const name of ${JSON.stringify(packageNames)}) require.resolve(name)`
        execFileSync(process.execPath, ['-e', script], { cwd: applicationPath })
        if (!options.verifyOpenFeature) {
          assert.throws(() => execFileSync(
            process.execPath,
            ['-e', `require.resolve('${explicitOptionalDependency}')`],
            { cwd: applicationPath, stdio: 'pipe' }
          ))
        }
      }

      agent = await new FakeAgent().start()
      const port = await getAvailablePort()
      const nodeOptions = options.nodeOptions ?? '--import dd-trace/initialize.mjs'
      const server = startStandaloneServer(applicationPath, port, agent.port, nodeOptions)
      childProcess = server.childProcess
      readOutput = server.readOutput
      url = `http://127.0.0.1:${port}`
      await waitForServer(url, childProcess)
    })

    after(async () => {
      await stopProc(childProcess)
      await agent?.stop()
      if (artifactRoot) {
        rmSync(artifactRoot, { recursive: true, force: true })
      }
    })

    it('loads the tracer before Next.js and traces requests', async () => {
      const requestPath = options.requestPath ?? '/api/health'
      await curlAndAssertMessage(agent, `${url}${requestPath}`, assertNextMessage, undefined, undefined, true)
      assert.doesNotMatch(readOutput(), /hook has already been initialized/)
    })
  })
}

describe('Next.js standalone output', function () {
  this.timeout(300_000)

  testStandaloneSetup(
    'with dd-trace/next without the OpenFeature peer',
    [
      commonFixtures,
      './packages/datadog-plugin-next/test/integration-test/standalone/helper/*',
    ],
    {
      removeOpenFeaturePeer: true,
      verifyOptionalDependencies: true,
    }
  )
  testStandaloneSetup(
    'with dd-trace/next and omitted optional dependencies',
    [
      commonFixtures,
      './packages/datadog-plugin-next/test/integration-test/standalone/helper/*',
    ],
    {
      nodeOptions: '--require dd-trace/init',
      removeOptionalDependencies: true,
    }
  )
  testStandaloneSetup(
    'with dd-trace/next and OpenFeature installed',
    [
      commonFixtures,
      './packages/datadog-plugin-next/test/integration-test/standalone/helper/*',
    ],
    {
      dependencies: [...nextDependencies, '@openfeature/server-sdk@^1'],
      verifyOpenFeature: true,
      verifyOptionalDependencies: true,
    }
  )
  testStandaloneSetup(
    'with an instrumentation import anchor',
    [
      commonFixtures,
      './packages/datadog-plugin-next/test/integration-test/standalone/import-anchor/*',
    ],
  )
  testStandaloneSetup(
    'with an instrumentation import anchor and only static routes',
    [
      commonFixtures,
      './packages/datadog-plugin-next/test/integration-test/standalone/import-anchor/*',
    ],
    {
      removeServerRoutes: true,
      requestPath: '/',
    }
  )
  testStandaloneSetup(
    'with dd-trace/next in a monorepo',
    ['./packages/datadog-plugin-next/test/integration-test/standalone/monorepo/*'],
    {
      applicationPath: ['apps', 'web'],
      standaloneOutputPath: ['apps', 'web', '.next', 'standalone'],
    }
  )
})
