'use strict'

const { createServer } = require('node:http')

const { OpenFeature, ProviderEvents } = require('@openfeature/server-sdk')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }
const Hook = proxyquire('../../../../src/openfeature/writers/flag-eval-evp-hook', {
  './util': {
    setExposureDeliveryStrategy: (config, onRoute) => {
      onRoute(true, { url: config.url, basePath: '/evp_proxy/v2' })
    },
  },
})
// Only external configuration and route discovery are replaced. The vendored
// evaluator, SDK hooks, producer, worker, serializer and HTTP transport are real.
const Provider = proxyquire('../../../../src/openfeature/flagging_provider', {
  './configuration_source': { create () {} },
  './writers/flag-eval-evp-hook': Hook,
})

const now = 1_790_150_400_000

/**
 * @param {boolean | undefined} consent
 * @param {boolean} [doLog]
 * @returns {import('@datadog/flagging-core').UniversalFlagConfigurationV1}
 */
function configuration (consent, doLog = false) {
  return {
    createdAt: '2026-09-23T00:00:00.000Z',
    format: 'SERVER',
    environment: { name: 'test' },
    ...(consent === undefined ? {} : { observeFullEvaluationData: consent }),
    flags: {
      flag: {
        key: 'flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: { on: { key: 'on', value: true } },
        allocations: [{ key: 'all', rules: [], splits: [{ variationKey: 'on', shards: [] }], doLog }],
      },
    },
  }
}

async function main () {
  const options = JSON.parse(process.argv[2] || '{"consent":true}')
  // Only Date is fake: worker scheduling and HTTP delivery stay real.
  const clock = sinon.useFakeTimers({ now, toFake: ['Date'] })
  const requests = []
  let received
  const delivery = new Promise(resolve => { received = resolve })
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, raw })
      res.writeHead(202).end()
      received()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const url = new URL('http://127.0.0.1:' + /** @type {import('node:net').AddressInfo} */ (server.address()).port)
  const provider = new Provider({}, /** @type {import('../../../../src/config/config-base')} */ ({
    url,
    service: 'released-provider-test',
    featureFlags: { DD_FLAGGING_EVALUATION_COUNTS_ENABLED: true },
    experimental: { flaggingProvider: { initializationTimeoutMs: 1000 } },
  }))
  try {
    const selected = configuration(options.consent, options.doLog)
    const flag = selected.flags.flag
    /** @type {{ targetingKey?: string, nested: { secret: string } }} */
    const context = { targetingKey: 'released-target-canary', nested: { secret: 'released-context-canary' } }
    const replacement = configuration(!options.consent)
    let consentReads = 0
    if (options.nestedConsent) {
      Object.assign(selected.environment, { observeFullEvaluationData: true })
      Object.assign(flag, { observeFullEvaluationData: true })
    }
    switch (options.path) {
      case 'disabled': flag.enabled = false; break
      case 'missing': delete selected.flags.flag; break
      case 'no-allocation': flag.allocations = []; break
      case 'mismatch':
        flag.variationType = 'STRING'
        flag.variations.on.value = 'on'
        break
      case 'malformed': Reflect.set(flag, 'allocations', null); break
      case 'target-missing':
        delete context.targetingKey
        flag.allocations[0].splits[0].shards = [
          { salt: 'salt', totalShards: 100, ranges: [{ start: 0, end: 100 }] },
        ]
        break
      case 'exception':
        Object.defineProperty(flag, 'enabled', { get () { throw new Error('released-error-canary') } })
        break
    }
    if (options.swap) {
      Object.defineProperty(selected, 'observeFullEvaluationData', {
        get () { consentReads++; return options.consent },
      })
      Object.defineProperty(selected.flags, 'flag', {
        get () {
          clock.setSystemTime(now + 500)
          provider.setConfiguration(replacement)
          if (options.path === 'swap-error') throw new Error('released-error-canary')
          return flag
        },
      })
    }
    if (options.path === 'not-ready') {
      OpenFeature.setProvider('released-provider', provider)
    } else {
      provider.setConfiguration(selected)
      await OpenFeature.setProviderAndWait('released-provider', provider)
      if (options.path === 'no-config') provider.setConfiguration(undefined)
      if (options.path === 'fatal') provider.events.emit(ProviderEvents.Error, { errorCode: 'PROVIDER_FATAL' })
    }
    const client = OpenFeature.getClient('released-provider')
    const details = []
    if (options.mixed) {
      for (const [i, consent] of [false, true, false, true].entries()) {
        clock.setSystemTime(now + i * 100)
        provider.setConfiguration(configuration(consent, options.doLog))
        details.push(await client.getBooleanDetails('flag', false, context))
      }
    } else {
      details.push(await client.getBooleanDetails('flag', false, context))
    }
    const swapped = provider.getConfiguration() === replacement
    context.targetingKey = 'mutated-target-canary'
    context.nested.secret = 'mutated-context-canary'
    clock.setSystemTime(now + 1000)
    provider.setConfiguration(replacement)
    provider.onClose()
    await delivery
    process.stdout.write(JSON.stringify({ details, requests, consentReads, swapped }))
  } finally {
    provider.onClose()
    await OpenFeature.clearProviders()
    await new Promise(resolve => server.close(resolve))
    clock.restore()
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n')
  process.exitCode = 1
})
