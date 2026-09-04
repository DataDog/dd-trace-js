'use strict'

/* eslint-disable no-console -- this is a demo CLI; its log output is the deliverable. */

// Local development harness for the SDK Configuration remote-config demo.
//
// This is NOT evidence about the Datadog backend. It stubs the Agent's POST /v0.7/config endpoint
// with the repo's FakeAgent, so the config payload is authored here rather than produced by
// rc-api. What it does exercise, for real, is everything below the Agent: the tracer's
// remote-config client (polling, product subscription, capability bits, target matching, ack
// reporting), the SDK_CONFIGURATION ingestion path in config/remote_config.js, and the
// 'datadog:config:update' -> profiler.js handoff that starts the profiler.
//
// Use it to iterate on the app quickly and to demonstrate layers 4-6 of the chain. Use
// publish-staging.sh for real rc-api evidence.
//
// Run with:  node demo/sdk-config-rc/local-harness.js [--legacy-array-shape]

const http = require('node:http')
const path = require('node:path')
const { fork } = require('node:child_process')

const FakeAgent = require('../../integration-tests/helpers/fake-agent')

const ACKNOWLEDGED = 2
const APP_PORT = Number(process.env.APP_PORT) || 18080
const USE_LEGACY = process.argv.includes('--legacy-array-shape')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log (...args) {
  console.log('[harness]', ...args)
}

function getState () {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${APP_PORT}/state`, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(new Error(`bad /state response: ${body.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
  })
}

async function waitFor (label, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await getState()
      if (predicate(last)) return last
    } catch {}
    await sleep(250)
  }
  throw new Error(`timed out waiting for: ${label}\nlast state: ${JSON.stringify(last, undefined, 2)}`)
}

/**
 * Build the APM_TRACING config file body.
 *
 * @param {Record<string, string>} settings - env-var-keyed settings to deliver
 *
 * The object form is what rc-api emits after ddoghq/dd-go#14029
 * ("make sdk_config.config a free-form map instead of a key/value array").
 * The array form is the pre-#14029 wire shape, which the combined tracer still
 * accepts via jsonconf's legacy decoder; --legacy-array-shape selects it.
 */
function buildConfigFile (settings) {
  const config = USE_LEGACY
    ? Object.entries(settings).map(([key, value]) => ({ key, value }))
    : settings

  return {
    service_target: { service: 'sdk-config-demo', env: 'demo' },
    sdk_config: {
      service_name: 'sdk-config-demo',
      env: 'demo',
      config,
    },
  }
}

function waitForAck (agent, configId) {
  return new Promise((resolve) => {
    const handler = (id, version, state, error) => {
      if (id !== configId) return
      log(`ack: id=${id} version=${version} apply_state=${state}${error ? ` error=${error}` : ''}`)
      if (state === ACKNOWLEDGED) {
        agent.removeListener('remote-config-ack-update', handler)
        resolve()
      }
    }
    agent.on('remote-config-ack-update', handler)
  })
}

async function main () {
  let failed = false
  const agent = await new FakeAgent().start()
  log(`FakeAgent listening on port ${agent.port}`)

  // Traces are incidental to the RC assertion, but the app is supposed to produce real activity,
  // so record what actually arrives and assert on it at the end.
  const spanNames = new Set()
  agent.on('message', ({ payload }) => {
    for (const trace of payload) {
      for (const span of trace) spanNames.add(span.name)
    }
  })
  log(`sdk_config.config wire shape: ${USE_LEGACY ? 'legacy array (pre-#14029)' : 'object map (post-#14029)'}`)

  const child = fork(path.join(__dirname, 'app.js'), {
    env: {
      ...process.env,
      DD_SERVICE: 'sdk-config-demo',
      DD_ENV: 'demo',
      DD_VERSION: '0.0.1',
      DD_TRACE_AGENT_PORT: String(agent.port),
      DD_REMOTE_CONFIGURATION_ENABLED: 'true',
      DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS: '1',
      DD_PROFILING_ENABLED: 'false',
      APP_PORT: String(APP_PORT),
    },
    stdio: 'inherit',
  })

  try {
    // ---- Step 1: baseline ------------------------------------------------
    const before = await waitFor('app to come up', (s) => s.service === 'sdk-config-demo')
    log('--- baseline ---')
    log(`  DD_PROFILING_ENABLED=${before.profiling.DD_PROFILING_ENABLED}` +
        `  origin=${before.profiling.origin}  profilerStarted=${before.profiling.profilerStarted}`)

    if (before.profiling.profilerStarted !== false) {
      throw new Error('expected profiler to be stopped at baseline')
    }
    if (before.remoteConfigEnabled !== true) {
      throw new Error('expected remote config to be enabled')
    }

    // ---- Step 2: publish DD_PROFILING_ENABLED=true -----------------------
    const configId = `demo-${Date.now()}`
    const file = buildConfigFile({ DD_PROFILING_ENABLED: 'true' })
    log('--- publishing APM_TRACING config ---')
    log(JSON.stringify(file, undefined, 2))

    const acked = waitForAck(agent, configId)
    agent.addRemoteConfig({ product: 'APM_TRACING', id: configId, config: file })
    await acked

    const after = await waitFor(
      'profiler to start via remote config',
      (s) => s.profiling.profilerStarted === true
    )
    log('--- after remote config ---')
    log(`  DD_PROFILING_ENABLED=${after.profiling.DD_PROFILING_ENABLED}` +
        `  origin=${after.profiling.origin}  profilerStarted=${after.profiling.profilerStarted}`)

    if (after.profiling.origin !== 'remote_config') {
      throw new Error(`expected origin 'remote_config', got '${after.profiling.origin}'`)
    }

    // ---- Step 3: revert ---------------------------------------------------
    log('--- reverting (removing the config) ---')
    agent.removeRemoteConfig(configId)
    const reverted = await waitFor(
      'profiler to stop after the config is removed',
      (s) => s.profiling.profilerStarted === false
    )
    log(`  DD_PROFILING_ENABLED=${reverted.profiling.DD_PROFILING_ENABLED}` +
        `  origin=${reverted.profiling.origin}  profilerStarted=${reverted.profiling.profilerStarted}`)

    if (spanNames.size === 0) {
      throw new Error('no traces reached the agent; the app produced no instrumented activity')
    }
    log(`traces received, span names: ${[...spanNames].sort().join(', ')}`)

    log('')
    log('RESULT: PASS')
    log('  profiler off -> on via SDK_CONFIGURATION remote config -> off again,')
    log('  origin transitioned default -> remote_config, and the tracer ACKed the config.')
  } catch (error) {
    failed = true
    log('')
    log('RESULT: FAIL')
    console.error(error)
  } finally {
    child.kill()
    await agent.stop().catch(() => {})
    // Demo CLI: the exit code is the pass/fail signal, and the tracer keeps handles alive.
    // eslint-disable-next-line n/no-process-exit
    process.exit(failed ? 1 : 0)
  }
}

main()
