'use strict'

const Axios = require('axios')
const { assert } = require('chai')
const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const msgpack = require('@msgpack/msgpack')

const { createSandbox, FakeAgent, spawnProc } = require('../helpers')

const exec = promisify(childProcess.exec)

describe('esbuild support for IAST', () => {
  describe('cjs', () => {
    let proc, agent, sandbox, axios
    let applicationDir, bundledApplicationDir

    before(async () => {
      sandbox = await createSandbox([])
      const cwd = sandbox.folder
      applicationDir = path.join(cwd, 'appsec/iast-esbuild')

      // Craft node_modules directory to ship native modules
      const craftedNodeModulesDir = path.join(applicationDir, 'tmp_node_modules')
      fs.mkdirSync(craftedNodeModulesDir)
      await exec('npm init -y', { cwd: craftedNodeModulesDir })
      await exec('npm install @datadog/native-iast-rewriter @datadog/native-iast-taint-tracking', {
        cwd: craftedNodeModulesDir,
        timeout: 3e3
      })

      // Install app deps
      await exec('npm install', {
        cwd: applicationDir,
        timeout: 3e3
      })

      // Bundle the application
      await exec('npm run build', {
        cwd: applicationDir,
        timeout: 3e3
      })

      bundledApplicationDir = path.join(applicationDir, 'build')

      // Copy crafted node_modules with native modules
      fs.cpSync(path.join(craftedNodeModulesDir, 'node_modules'), bundledApplicationDir, { recursive: true })
    })

    after(async () => {
      await sandbox.remove()
    })

    function startServer (appFile, iastEnabled) {
      beforeEach(async () => {
        agent = await new FakeAgent().start()
        proc = await spawnProc(path.join(bundledApplicationDir, appFile), {
          cwd: applicationDir,
          env: {
            DD_TRACE_AGENT_PORT: agent.port,
            DD_IAST_ENABLED: String(iastEnabled),
            DD_IAST_REQUEST_SAMPLING: '100',
          }
        })
        axios = Axios.create({ baseURL: proc.url })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })
    }

    describe('with IAST enabled', () => {
      describe('with sourcemap esbuild option enabled', () => {
        startServer('iast-enabled-with-sm.js', true)

        it('should detect vulnerability with correct location', async () => {
          await axios.get('/iast/cmdi-vulnerable?args=-la')

          const expectedVulnerabilityType = 'COMMAND_INJECTION'
          const expectedVulnerabilityLocationPath = path.join('iast', 'index.js')
          const expectedVulnerabilityLocationLine = 9

          await agent.assertMessageReceived(({ payload }) => {
            const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
            spans.forEach(span => {
              assert.property(span.meta, '_dd.iast.json')
              const spanIastData = JSON.parse(span.meta['_dd.iast.json'])
              assert.strictEqual(spanIastData.vulnerabilities[0].type, expectedVulnerabilityType)
              assert.strictEqual(spanIastData.vulnerabilities[0].location.path, expectedVulnerabilityLocationPath)
              assert.strictEqual(spanIastData.vulnerabilities[0].location.line, expectedVulnerabilityLocationLine)

              const ddStack = msgpack.decode(span.meta_struct['_dd.stack'])
              assert.property(ddStack.vulnerability[0], 'frames')
              assert.isNotEmpty(ddStack.vulnerability[0].frames)
            })
          }, null, 1, true)
        })
      })

      describe('with sourcemap esbuild option disabled', () => {
        startServer('iast-enabled-with-no-sm.js', true)

        it('should detect vulnerability with first callsite location', async () => {
          await axios.get('/iast/cmdi-vulnerable?args=-la')

          const expectedVulnerabilityType = 'COMMAND_INJECTION'
          const expectedVulnerabilityLocationPath = path.join('build', 'iast-enabled-with-no-sm.js')

          await agent.assertMessageReceived(({ payload }) => {
            const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
            spans.forEach(span => {
              assert.property(span.meta, '_dd.iast.json')
              const spanIastData = JSON.parse(span.meta['_dd.iast.json'])
              assert.strictEqual(spanIastData.vulnerabilities[0].type, expectedVulnerabilityType)
              assert.strictEqual(spanIastData.vulnerabilities[0].location.path, expectedVulnerabilityLocationPath)

              const ddStack = msgpack.decode(span.meta_struct['_dd.stack'])
              assert.property(ddStack.vulnerability[0], 'frames')
              assert.isNotEmpty(ddStack.vulnerability[0].frames)
            })
          }, null, 1, true)
        })
      })
    })

    describe('with IAST disabled', () => {
      startServer('iast-disabled.js', false)

      it('should not detect any vulnerability', async () => {
        await axios.get('/iast/cmdi-vulnerable?args=-la')
        await agent.assertMessageReceived(({ payload }) => {
          const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
          spans.forEach(span => {
            assert.notProperty(span.meta, '_dd.iast.json')
          })
        }, null, 1, true)
      })
    })
  })
})
