'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const semver = require('semver')

const {
  FakeAgent,
  checkSpansForServiceName,
  sandboxCwd,
  spawnProc,
  stopProc,
} = require('../helpers')
const httpRequest = require('../../packages/dd-trace/test/setup/helpers/http-client')

const fixtureDependencies = ['@hono/node-server', 'express', 'graphql', 'hono']
const formats = { cjs: 'cjs', es: 'mjs' }

/**
 * @param {string} name
 */
function readPackageJson (name) {
  return require(path.join(sandboxCwd(), 'node_modules', name, 'package.json'))
}

/**
 * Release lines still testing older Node.js versions run these suites, but newer Vite versions and Vite-based tools
 * do not support them.
 *
 * @param {string[]} names
 */
function supportsNode (names) {
  return names.every(name => {
    const { engines } = readPackageJson(name)
    return !engines?.node || semver.satisfies(process.versions.node, engines.node)
  })
}

/**
 * @param {string} cwd
 * @param {string} command
 * @param {keyof formats} format
 * @param {Record<string, string>} [env]
 */
function build (cwd, command, format, env) {
  const file = path.join(sandboxCwd(), 'node_modules', '.bin', command)
  execFileSync(file, ['build'], {
    cwd,
    env: { ...process.env, ...env, NODE_OPTIONS: '', VITE_OUTPUT_FORMAT: format },
    killSignal: 'SIGKILL',
    stdio: 'inherit',
    timeout: 120_000,
  })
}

/**
 * @param {string} entry
 * @param {import('node:child_process').ForkOptions} [options]
 */
async function assertAppTraces (entry, options) {
  const agent = await new FakeAgent().start()
  let proc
  try {
    proc = await spawnProc(entry, {
      ...options,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        DD_TRACE_AGENT_PORT: String(agent.port),
        DD_TRACE_FLUSH_INTERVAL: '0',
      },
    })
    // Express uses a CommonJS hook; the GraphQL execution span requires an Orchestrion rewrite.
    await assertRoute('/graphql', { data: { hello: 'ok' } }, ['express.request', 'graphql.execute'])
    // Hono's ESM class export has to be intercepted before its constructor is called.
    await assertRoute('/hono', { hello: 'ok' }, ['hono.request'])
  } finally {
    await Promise.all([stopProc(proc), agent.stop()])
  }

  /**
   * @param {string} route
   * @param {object} expected
   * @param {string[]} spans
   */
  async function assertRoute (route, expected, spans) {
    const [response] = await Promise.all([
      httpRequest.get(`${proc.url}${route}`),
      agent.assertMessageReceived(({ payload }) => {
        for (const span of spans) {
          assert.ok(checkSpansForServiceName(payload, span), `${span} span not found`)
        }
      }, 10_000, 1, true),
    ])
    assert.deepStrictEqual(response.data, expected)
  }
}

module.exports = { assertAppTraces, build, fixtureDependencies, formats, supportsNode }
