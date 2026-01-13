'use strict'

const assert = require('node:assert/strict')

const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const Axios = require('axios')
const msgpack = require('@msgpack/msgpack')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../helpers')

const exec = promisify(childProcess.exec)
const retry = async fn => {
  try {
    await fn()
  } catch {
    await exec('sleep 60')
    await fn()
  }
}

describe('esbuild support for IAST', () => {
  let cwd, craftedNodeModulesDir

  useSandbox()

  before(async () => {
    this.timeout(120_000)

    cwd = sandboxCwd()
    craftedNodeModulesDir = path.join(cwd, 'tmp_node_module')

    // Craft node_modules directory to ship native modules
    fs.mkdirSync(craftedNodeModulesDir)
    await exec('npm init -y', { cwd: craftedNodeModulesDir })
    await retry(() => exec('npm install @datadog/wasm-js-rewriter @datadog/native-iast-taint-tracking', {
      cwd: craftedNodeModulesDir,
      timeout: 3e3
    }))
  })

  function assertVulnerabilityDetected (agent, expectedPath, expectedLine) {
    return agent.assertMessageReceived(({ payload }) => {
      const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
      spans.forEach(span => {
        assert.ok(Object.hasOwn(span.meta, '_dd.iast.json'))
        const spanIastData = JSON.parse(span.meta['_dd.iast.json'])
        assert.strictEqual(spanIastData.vulnerabilities[0].type, 'COMMAND_INJECTION')
        assert.strictEqual(spanIastData.vulnerabilities[0].location.path, expectedPath)
        if (expectedLine) {
          assert.strictEqual(spanIastData.vulnerabilities[0].location.line, expectedLine)
        }

        const ddStack = msgpack.decode(span.meta_struct['_dd.stack'])
        assert.ok(Object.hasOwn(ddStack.vulnerability[0], 'frames'))
        assert.ok(ddStack.vulnerability[0].frames.length > 0)
      })
    }, null, 1, true)
  }

  function assertNoVulnerability (agent) {
    return agent.assertMessageReceived(({ payload }) => {
      const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
      spans.forEach(span => {
        assert.ok(!('_dd.iast.json' in span.meta))
      })
    }, null, 1, true)
  }

  async function setupApplication (appDirName) {
    const applicationDir = path.join(cwd, 'appsec', appDirName)

    // Install app deps
    await retry(() => exec('npm install', {
      cwd: applicationDir,
      timeout: 6e3
    }))

    // Bundle the application
    await exec('npm run build', {
      cwd: applicationDir,
      timeout: 10e3
    })

    const bundledApplicationDir = path.join(applicationDir, 'build')

    // Copy crafted node_modules with native modules
    fs.cpSync(path.join(craftedNodeModulesDir, 'node_modules'), bundledApplicationDir, { recursive: true })

    return { applicationDir, bundledApplicationDir }
  }

  function createServerStarter (contextVars) {
    return function startServer (appFile, iastEnabled) {
      beforeEach(async () => {
        contextVars.agent = await new FakeAgent().start()
        contextVars.proc = await spawnProc(path.join(contextVars.bundledApplicationDir, appFile), {
          cwd: contextVars.applicationDir,
          env: {
            DD_TRACE_AGENT_PORT: contextVars.agent.port,
            DD_IAST_ENABLED: String(iastEnabled),
            DD_IAST_REQUEST_SAMPLING: '100',
          }
        })
        contextVars.axios = Axios.create({ baseURL: contextVars.proc.url })
      })

      afterEach(async () => {
        contextVars.proc.kill()
        await contextVars.agent.stop()
      })
    }
  }

  describe('cjs', () => {
    const context = { proc: null, agent: null, axios: null, applicationDir: null, bundledApplicationDir: null }

    before(async () => {
      const setup = await setupApplication('iast-esbuild-cjs')
      context.applicationDir = setup.applicationDir
      context.bundledApplicationDir = setup.bundledApplicationDir
    })

    const startServer = createServerStarter(context)

    describe('with IAST enabled', () => {
      describe('with sourcemap esbuild option enabled', () => {
        startServer('iast-enabled-with-sm.js', true)

        it('should detect vulnerability with correct location', async () => {
          await context.axios.get('/iast/cmdi-vulnerable?args=-la')

          const expectedPath = path.join('iast', 'index.js')
          const expectedLine = 9

          await assertVulnerabilityDetected(context.agent, expectedPath, expectedLine)
        })
      })

      describe('with sourcemap esbuild option disabled', () => {
        startServer('iast-enabled-with-no-sm.js', true)

        it('should detect vulnerability with first callsite location', async () => {
          await context.axios.get('/iast/cmdi-vulnerable?args=-la')

          const expectedPath = path.join('build', 'iast-enabled-with-no-sm.js')

          await assertVulnerabilityDetected(context.agent, expectedPath)
        })
      })
    })

    describe('with IAST disabled', () => {
      startServer('iast-disabled.js', false)

      it('should not detect any vulnerability', async () => {
        await context.axios.get('/iast/cmdi-vulnerable?args=-la')
        await assertNoVulnerability(context.agent)
      })
    })
  })

  describe('esm', () => {
    const context = { proc: null, agent: null, axios: null, applicationDir: null, bundledApplicationDir: null }

    before(async () => {
      const setup = await setupApplication('iast-esbuild-esm')
      context.applicationDir = setup.applicationDir
      context.bundledApplicationDir = setup.bundledApplicationDir
    })

    const startServer = createServerStarter(context)

    describe('with IAST enabled', () => {
      describe('with sourcemap esbuild option enabled', () => {
        startServer('iast-enabled-with-sm.mjs', true)

        it('should detect vulnerability with correct location', async () => {
          await context.axios.get('/iast/cmdi-vulnerable?args=-la')

          const expectedPath = path.join('iast', 'index.mjs')
          const expectedLine = 7

          await assertVulnerabilityDetected(context.agent, expectedPath, expectedLine)
        })
      })

      describe('with sourcemap esbuild option disabled', () => {
        startServer('iast-enabled-with-no-sm.mjs', true)

        it('should detect vulnerability with first callsite location', async () => {
          await context.axios.get('/iast/cmdi-vulnerable?args=-la')

          const expectedPath = path.join('build', 'iast-enabled-with-no-sm.mjs')

          await assertVulnerabilityDetected(context.agent, expectedPath)
        })
      })
    })

    describe('with IAST disabled', () => {
      startServer('iast-disabled.mjs', false)

      it('should not detect any vulnerability', async () => {
        await context.axios.get('/iast/cmdi-vulnerable?args=-la')
        await assertNoVulnerability(context.agent)
      })
    })
  })
})
