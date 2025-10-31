'use strict'

const path = require('node:path')
const assert = require('node:assert')
const { execSync } = require('node:child_process')

const axios = require('axios')

const { FakeAgent, spawnProc, sandboxCwd, useSandbox } = require('../helpers')

const esbuildVersions = ['latest', '0.16.12']

function findWebSpan (payload) {
  for (const trace of payload) {
    for (const span of trace) {
      if (span.type === 'web') {
        return span
      }
    }
  }
  throw new Error('web span not found')
}

esbuildVersions.forEach((version) => {
  describe('ESM is built and runs as expected in a sandbox', () => {
    let agent, cwd

    useSandbox([`esbuild@${version}`, 'hono', '@hono/node-server'], false, [__dirname])

    before(() => {
      cwd = sandboxCwd()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(() => {
      agent.stop()
    })

    it('should build basic esm http server exporting esm and create web traces at runtime', async () => {
      const builder = path.join(cwd, 'esbuild', 'build.esm-http-output-esm.mjs')
      execSync(`node ${builder}`, { cwd })

      const appFile = path.join(cwd, 'esbuild', 'esm-http-test-out.mjs')
      const proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`
        },
        stdio: 'pipe',
      })

      await Promise.all([
        agent.assertMessageReceived(({ payload }) => {
          // http web spans are created in bundled application
          const webSpan = findWebSpan(payload)
          assert.strictEqual(webSpan.name, 'web.request')
        }, 2_500),
        axios.get(proc.url)
      ])
    })

    it('should build basic esm http server exporting cjs and create web traces at runtime', async () => {
      const builder = path.join(cwd, 'esbuild', 'build.esm-http-output-cjs.mjs')
      execSync(`node ${builder}`, { cwd })

      const appFile = path.join(cwd, 'esbuild', 'esm-http-test-out.cjs')
      const proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`
        },
        stdio: 'pipe',
      })

      await Promise.all([
        agent.assertMessageReceived(({ payload }) => {
          // http web spans are created in bundled application
          const webSpan = findWebSpan(payload)
          assert.strictEqual(webSpan.name, 'web.request')
        }, 2_500),
        axios.get(proc.url)
      ])
    })

    it('should build basic hono server exporting esm and create web traces at runtime', async () => {
      const builder = path.join(cwd, 'esbuild', 'build.esm-hono-output-esm.mjs')
      execSync(`node ${builder}`, { cwd })

      const appFile = path.join(cwd, 'esbuild', 'hono-out.mjs')
      const proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`
        },
        stdio: 'pipe',
      })

      await Promise.all([
        agent.assertMessageReceived(({ payload }) => {
          // http web spans are created in bundled application
          const webSpan = findWebSpan(payload)
          assert.strictEqual(webSpan.name, 'hono.request')
        }, 2_500),
        axios.get(proc.url)
      ])
    })

    it('should build basic hono server exporting cjs and create web traces at runtime', async () => {
      const builder = path.join(cwd, 'esbuild', 'build.esm-hono-output-cjs.mjs')
      execSync(`node ${builder}`, { cwd })

      const appFile = path.join(cwd, 'esbuild', 'hono-out.cjs')
      const proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`
        },
        stdio: 'pipe',
      })

      await Promise.all([
        agent.assertMessageReceived(({ payload }) => {
          // http web spans are created in bundled application
          const webSpan = findWebSpan(payload)
          assert.strictEqual(webSpan.name, 'hono.request')
        }, 2_500),
        axios.get(proc.url)
      ])
    })
  })
})
