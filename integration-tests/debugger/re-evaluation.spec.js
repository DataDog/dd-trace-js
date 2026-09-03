'use strict'

const { randomUUID } = require('node:crypto')
const assert = require('node:assert')
const { on } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')

const { sandboxCwd, useSandbox, FakeAgent, assertObjectContains, spawnProc } = require('../helpers')
const { generateProbeConfig } = require('../../packages/dd-trace/test/debugger/devtools_client/utils')

// A race condition exists where the tracer receives a probe via RC, before Node.js has had a chance to load all the JS
// files from disk. If this race condition is triggered, it results in the tracer either not being able to find any
// script to attach the probe to, or, if the probe filename is a bit generic, it finds an incorrect match.
//
// If it can't find any script matching the expected filename, instead of emitting an `INSTALLED` event, it emits an
// `ERROR` event with the message: `No loaded script found for <file>`.
//
// If it finds any incorrect match, where it's possible to attach a breakpoint to the line requested, the race
// condition is a little less obvious, as the tracer just attaches to this wrong script. In this case, the test
// behavior depends on where the breakpoint ends up being attached. In most cases, the test just times out, as the
// breakpoint is never exercised during the test, and the tracer therefore never emits the `EMITTING` event.
//
// This is only really an issue if Node.js is using the ESM loader, as this is really slow. If the application is
// purely a CommonJS application, this race condition will probably never be triggered.
//
// This test tries to trigger the race condition. However, it doesn't always happen, so it runs multiple times.
describe('Dynamic Instrumentation Probe Re-Evaluation', function () {
  useSandbox(
    undefined,
    undefined,
    // Ensure the test scripts live in the root of the sandbox so they are always the shortest path when
    // `findScriptFromPartialPath` is called
    ['./integration-tests/debugger/target-app/re-evaluation/*']
  )

  describe('Could not find source file', genTestsForSourceFile('unique-filename.js'))

  describe('Initially finds the wrong source file', genTestsForSourceFile('index.js'))

  function genTestsForSourceFile (sourceFile) {
    return function () {
      let rcConfig, agent, proc

      beforeEach(async function () {
        rcConfig = {
          product: 'LIVE_DEBUGGING',
          id: `logProbe_${randomUUID()}`,
          config: generateProbeConfig({ sourceFile, line: 4 }),
        }
        agent = await new FakeAgent().start()
        proc = undefined
      })

      afterEach(async function () {
        proc?.kill()
        await agent?.stop()
      })

      for (let attempt = 1; attempt <= 5; attempt++) {
        const testName = 'should attach probe to the right script, ' +
          'even if it is not loaded when the probe is received ' +
          `(attempt ${attempt})`

        it(testName, async function () {
          this.timeout(5000)

          const probeId = rcConfig.config.id
          const expectedPayloads = [{
            ddsource: 'dd_debugger',
            service: 're-evaluation-test',
            debugger: { diagnostics: { probeId, probeVersion: 0, status: 'RECEIVED' } },
          }, {
            ddsource: 'dd_debugger',
            service: 're-evaluation-test',
            debugger: { diagnostics: { probeId, probeVersion: 0, status: 'INSTALLED' } },
          }, {
            ddsource: 'dd_debugger',
            service: 're-evaluation-test',
            debugger: { diagnostics: { probeId, probeVersion: 0, status: 'EMITTING' } },
          }]
          const receivedPayloads = []

          /** @param {{ payload: Array<object> }} event */
          function collectDiagnostics ({ payload }) {
            receivedPayloads.push(...payload)
          }
          agent.on('debugger-diagnostics', collectDiagnostics)

          const diagnostics = on(agent, 'debugger-diagnostics')
          agent.addRemoteConfig(rcConfig)

          proc = await spawnProc(sourceFile, {
            cwd: sandboxCwd(),
            env: {
              NODE_OPTIONS: '--import dd-trace/initialize.mjs',
              DD_DYNAMIC_INSTRUMENTATION_ENABLED: 'true',
              DD_DYNAMIC_INSTRUMENTATION_UPLOAD_INTERVAL_SECONDS: '0',
              DD_TRACE_AGENT_PORT: agent.port,
              DD_TRACE_DEBUG: process.env.DD_TRACE_DEBUG, // inherit to make debugging the sandbox easier
              DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '0.1',
            },
          })
          assert(proc, 'proc must be spawned successfully')

          try {
            for await (const [{ payload }] of diagnostics) {
              for (const event of payload) {
                if (event.debugger.diagnostics.status === 'ERROR') {
                  // shortcut to fail with a more relevant error message in case the target script could not be found,
                  // instead of asserting the entire expected event.
                  assert.fail(event.debugger.diagnostics.exception.message)
                }

                const expected = expectedPayloads.shift()
                assertObjectContains(event, expected)

                if (event.debugger.diagnostics.status === 'INSTALLED') {
                  const response = await fetch(proc.url)
                  assert.strictEqual(response.status, 200)
                  await response.arrayBuffer()
                }
              }

              if (expectedPayloads.length === 0) break
            }
            await delay(200)
          } finally {
            agent.removeListener('debugger-diagnostics', collectDiagnostics)
          }
          assert.strictEqual(receivedPayloads.length, 3)
        })
      }
    }
  }
})
