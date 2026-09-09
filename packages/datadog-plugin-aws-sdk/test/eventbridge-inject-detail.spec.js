'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { afterEach, describe, it } = require('mocha')
const { channel } = require('dc-polyfill')

const { PATHWAY_FIELD_BYTES } = require('../../dd-trace/src/datastreams/size')
const log = require('../../dd-trace/src/log')
const EventBridge = require('../src/services/eventbridge')

const requestStartChannel = channel('apm:aws:request:start:eventbridge')
const activePlugins = []
const tracerConfig = {
  cloudPayloadTagging: {},
  codeOriginForSpans: {
    enabled: false,
    experimental: {
      exit_spans: {
        enabled: false,
      },
    },
  },
  peerServiceMapping: {},
  spanComputePeerService: false,
}
const TRACE_CONTEXT = {
  'x-datadog-trace-id': '123',
  'x-datadog-parent-id': '456',
  'x-datadog-sampling-priority': '1',
}
const TRACE_CONTEXT_BYTES = Buffer.byteLength(`,"_datadog":${JSON.stringify(TRACE_CONTEXT)}`)
const MAX_PUT_EVENTS_BYTES = 1024 * 1024

function createSpan () {
  const tags = {}
  return {
    addTags (newTags) {
      Object.assign(tags, newTags)
    },
    context () {
      return {
        getTag (key) {
          return tags[key]
        },
        getTags () {
          return tags
        },
      }
    },
    finish () {},
    setTag (key, value) {
      tags[key] = value
    },
  }
}

/**
 * @param {number} size total UTF-8 byte length of the returned JSON object
 */
function makeEventDetail (size) {
  const prefix = '{"myGreatData":"'
  const suffix = '"}'
  return `${prefix}${'a'.repeat(size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`
}

/**
 * Subscribe a fully wired EventBridge plugin to the AWS diagnostic channel. `afterEach` tears every
 * plugin built here back down, so `publishRequest` only ever reaches the one under test.
 *
 * Both flags are passed explicitly because `aws-sdk.spec.js` exports
 * `DD_TRACE_AWS_SDK_BATCH_PROPAGATION_ENABLED` into the build-once config singleton.
 *
 * @param {object} [options]
 * @param {boolean} [options.dsmEnabled]
 * @param {boolean} [options.batchPropagationEnabled]
 * @param {() => Record<string, string>|undefined} [options.inject]
 * @param {(edgeTags: string[], span: unknown, payloadSize: number, pathwayContextSize: number)
 *   => object|undefined} [options.setCheckpoint]
 */
function buildChannelPlugin ({
  dsmEnabled = false,
  batchPropagationEnabled = false,
  inject = () => ({ ...TRACE_CONTEXT }),
  setCheckpoint = () => undefined,
} = {}) {
  const tracer = {
    _nomenclature: {
      opName: () => 'aws.request',
      serviceName: () => 'test-aws-eventbridge',
    },
    _service: 'test',
    inject,
    setCheckpoint,
    startSpan: () => createSpan(),
  }
  const plugin = new EventBridge(tracer, tracerConfig)

  plugin.configure({ batchPropagationEnabled, dsmEnabled, enabled: true })
  activePlugins.push(plugin)
}

/**
 * Record every checkpoint the plugin sets and hand back a pathway context whose hash is unique per
 * call, the way distinct edge tags produce distinct hashes in production.
 *
 * @param {unknown[][]} calls
 */
function recordingCheckpoint (calls) {
  return (...args) => {
    calls.push(args)
    const hash = Buffer.alloc(8)
    hash.writeUInt8(calls.length)
    return { hash, pathwayStartNs: 0, edgeStartNs: 0 }
  }
}

/**
 * @param {'error'|'info'} level
 * @param {() => void} run
 */
function captureLog (level, run) {
  const original = log[level]
  const calls = []
  log[level] = (...args) => calls.push(args)
  try {
    run()
  } finally {
    log[level] = original
  }
  return calls
}

/**
 * Drive the request through the diagnostic channel the AWS instrumentation publishes on, so the
 * plugin `buildChannelPlugin` subscribed picks it up exactly as it would in production.
 *
 * @param {object} request
 */
function publishRequest (request) {
  requestStartChannel.runStores(
    {
      awsRegion: 'us-east-1',
      awsService: 'EventBridge',
      cbExists: false,
      operation: request.operation,
      request,
      serviceIdentifier: 'eventbridge',
    },
    () => {},
  )
}

/**
 * @param {object} entry
 */
function injectedContext (entry) {
  return JSON.parse(entry.Detail)._datadog
}

afterEach(() => {
  while (activePlugins.length > 0) {
    activePlugins.pop().configure(false)
  }
})

describe('EventBridge plugin requestInject', () => {
  it('leaves requests for other operations untouched', () => {
    buildChannelPlugin()
    const request = {
      operation: 'listRules',
      params: { Entries: [{ Detail: '{"id":1}' }] },
    }

    publishRequest(request)

    assert.strictEqual(request.params.Entries[0].Detail, '{"id":1}')
  })

  it('leaves a putEvents request without entries untouched', () => {
    buildChannelPlugin()
    const request = { operation: 'putEvents', params: { Entries: [] } }

    publishRequest(request)

    assert.deepStrictEqual(request.params.Entries, [])
  })

  it('injects the trace context into the first entry only', () => {
    buildChannelPlugin()
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    }

    publishRequest(request)

    assert.deepStrictEqual(injectedContext(request.params.Entries[0]), TRACE_CONTEXT)
    assert.strictEqual(request.params.Entries[1].Detail, '{"id":2}')
  })

  it('leaves the batch untouched when the first entry carries no string detail', () => {
    buildChannelPlugin()
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Source: 'checkout' }, { Detail: '{"id":2}' }] },
    }

    publishRequest(request)

    assert.deepStrictEqual(request.params.Entries, [{ Source: 'checkout' }, { Detail: '{"id":2}' }])
  })

  it('leaves the batch untouched when the first detail is not a JSON object', () => {
    buildChannelPlugin()
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: 'not-json' }, { Detail: '{"id":2}' }] },
    }

    const errors = captureLog('error', () => publishRequest(request))

    assert.deepStrictEqual(request.params.Entries, [{ Detail: 'not-json' }, { Detail: '{"id":2}' }])
    assert.strictEqual(errors.length, 1)
  })

  it('injects the trace context into every entry when batch propagation is enabled', () => {
    buildChannelPlugin({ batchPropagationEnabled: true })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    }

    publishRequest(request)

    assert.deepStrictEqual(injectedContext(request.params.Entries[0]), TRACE_CONTEXT)
    assert.deepStrictEqual(injectedContext(request.params.Entries[1]), TRACE_CONTEXT)
  })

  it('leaves every entry untouched when the propagator injects nothing', () => {
    buildChannelPlugin({ batchPropagationEnabled: true, inject: () => undefined })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    }

    publishRequest(request)

    assert.deepStrictEqual(request.params.Entries, [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }])
  })

  it('adds the pathway to every entry and the trace context to the first', () => {
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint([]) })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    }

    publishRequest(request)

    const first = injectedContext(request.params.Entries[0])
    const second = injectedContext(request.params.Entries[1])
    assert.deepStrictEqual(Object.keys(first), [...Object.keys(TRACE_CONTEXT), 'dd-pathway-ctx-base64'])
    assert.deepStrictEqual(Object.keys(second), ['dd-pathway-ctx-base64'])
    assert.strictEqual(first['dd-pathway-ctx-base64'].length, 28)
    assert.notStrictEqual(second['dd-pathway-ctx-base64'], first['dd-pathway-ctx-base64'])
  })

  it('builds one pathway-only carrier for every entry past the first', () => {
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint([]) })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }, { Detail: '{"id":3}' }],
      },
    }

    publishRequest(request)

    const pathways = request.params.Entries.map(entry => injectedContext(entry)['dd-pathway-ctx-base64'])
    assert.strictEqual(new Set(pathways).size, 3)
    assert.deepStrictEqual(Object.keys(injectedContext(request.params.Entries[1])), ['dd-pathway-ctx-base64'])
    assert.deepStrictEqual(Object.keys(injectedContext(request.params.Entries[2])), ['dd-pathway-ctx-base64'])
  })

  it('adds the pathway alone when the propagator injects nothing', () => {
    buildChannelPlugin({
      dsmEnabled: true,
      inject: () => undefined,
      setCheckpoint: recordingCheckpoint([]),
    })
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: '{"id":1}' }] },
    }

    publishRequest(request)

    assert.deepStrictEqual(Object.keys(injectedContext(request.params.Entries[0])), ['dd-pathway-ctx-base64'])
  })

  it('keeps the trace context and drops the pathway when no checkpoint is recorded', () => {
    buildChannelPlugin({ dsmEnabled: true })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    }

    publishRequest(request)

    assert.deepStrictEqual(injectedContext(request.params.Entries[0]), TRACE_CONTEXT)
    assert.strictEqual(request.params.Entries[1].Detail, '{"id":2}')
  })

  it('keeps propagating the batch when one detail is not a JSON object', () => {
    buildChannelPlugin({ batchPropagationEnabled: true })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{ Detail: 'not-json' }, { Detail: '{"id":2}' }],
      },
    }

    const errors = captureLog('error', () => publishRequest(request))

    assert.strictEqual(request.params.Entries[0].Detail, 'not-json')
    assert.deepStrictEqual(injectedContext(request.params.Entries[1]), TRACE_CONTEXT)
    assert.strictEqual(errors.length, 1)
    assert.strictEqual(errors[0][0], 'EventBridge error injecting request')
  })

  it('skips entries that carry no string detail', () => {
    buildChannelPlugin({ batchPropagationEnabled: true })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [null, { Detail: 42 }, { Source: 'checkout' }, { Detail: '{"id":4}' }],
      },
    }

    publishRequest(request)

    assert.deepStrictEqual(request.params.Entries.slice(0, 3), [null, { Detail: 42 }, { Source: 'checkout' }])
    assert.deepStrictEqual(injectedContext(request.params.Entries[3]), TRACE_CONTEXT)
  })

  it('stays quiet about the cap when no entry could have taken the context anyway', () => {
    buildChannelPlugin({ batchPropagationEnabled: true })
    const oversizedDetail = 'x'.repeat(MAX_PUT_EVENTS_BYTES)
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: 'not-json' }, { Detail: oversizedDetail }] },
    }

    const infos = captureLog('info', () => captureLog('error', () => publishRequest(request)))

    assert.deepStrictEqual(
      request.params.Entries.map(entry => entry.Detail),
      ['not-json', oversizedDetail],
    )
    assert.deepStrictEqual(infos, [])
  })

  it('injects a request that stays below the 1 MiB cap', () => {
    buildChannelPlugin()
    const detail = makeEventDetail(MAX_PUT_EVENTS_BYTES - 1 - TRACE_CONTEXT_BYTES)
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: detail }] },
    }

    const infos = captureLog('info', () => publishRequest(request))

    assert.strictEqual(Buffer.byteLength(request.params.Entries[0].Detail), MAX_PUT_EVENTS_BYTES - 1)
    assert.deepStrictEqual(infos, [])
  })

  it('skips a request that would reach the 1 MiB cap', () => {
    buildChannelPlugin()
    const detail = makeEventDetail(MAX_PUT_EVENTS_BYTES - TRACE_CONTEXT_BYTES)
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: detail }] },
    }

    const infos = captureLog('info', () => publishRequest(request))

    assert.strictEqual(request.params.Entries[0].Detail, detail)
    assert.deepStrictEqual(infos, [['Payload size too large to pass context']])
  })

  it('counts the whole batch against the cap, not a single entry', () => {
    buildChannelPlugin({ batchPropagationEnabled: true })
    const detail = makeEventDetail(MAX_PUT_EVENTS_BYTES / 2)
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: detail }, { Detail: detail }] },
    }

    const infos = captureLog('info', () => publishRequest(request))

    assert.deepStrictEqual(request.params.Entries, [{ Detail: detail }, { Detail: detail }])
    assert.deepStrictEqual(infos, [['Payload size too large to pass context']])
  })

  it('reserves the pathway field in the size check and records no checkpoint when it no longer fits', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const detail = makeEventDetail(MAX_PUT_EVENTS_BYTES - TRACE_CONTEXT_BYTES - PATHWAY_FIELD_BYTES)
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: detail }] },
    }

    const infos = captureLog('info', () => publishRequest(request))

    assert.strictEqual(request.params.Entries[0].Detail, detail)
    assert.deepStrictEqual(calls, [])
    assert.deepStrictEqual(infos, [['Payload size too large to pass context']])
  })

  it('reports the caller-built byte size to every checkpoint, not the injected one', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: '{"id":1}', Source: 'checkout', DetailType: 'invoice.created' },
          { Detail: '{"id":2}' },
        ],
      },
    }

    publishRequest(request)

    assert.strictEqual(
      calls[0][2],
      Buffer.byteLength('{"id":1}') + Buffer.byteLength('checkout') + Buffer.byteLength('invoice.created'),
    )
    assert.strictEqual(calls[1][2], Buffer.byteLength('{"id":2}'))
    // The `_datadog` context ships but is not the caller's payload, so it must not be reported.
    assert.ok(Buffer.byteLength(request.params.Entries[1].Detail) > calls[1][2])
  })

  it('opts out of the pathway estimate the processor adds for other producers', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: '{"id":1}' }] },
    }

    publishRequest(request)

    assert.strictEqual(calls[0][3], 0)
  })

  it('sizes every field EventBridge bills for except Time', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{
          Detail: '{"id":1}',
          DetailType: 'invoice.created',
          EventBusName: 'payments',
          Resources: ['arn:one', 'arn:two'],
          Source: 'checkout',
          Time: new Date(),
          TraceHeader: 'Root=1-5759e988',
        }],
      },
    }

    publishRequest(request)

    assert.strictEqual(calls[0][2], Buffer.byteLength(
      '{"id":1}' + 'invoice.created' + 'payments' + 'arn:one' + 'arn:two' + 'checkout' + 'Root=1-5759e988',
    ))
  })

  it('sizes multibyte fields by their UTF-8 byte length', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{ Detail: '{"emoji":"🎉"}', DetailType: 'facturé', Source: '注文' }],
      },
    }

    publishRequest(request)

    assert.strictEqual(calls[0][2], Buffer.byteLength('{"emoji":"🎉"}' + 'facturé' + '注文'))
    assert.ok(calls[0][2] > '{"emoji":"🎉"}facturé注文'.length)
  })

  it('skips resources that are not strings when sizing', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: '{}', Resources: ['keep', null, 7] }] },
    }

    publishRequest(request)

    assert.strictEqual(calls[0][2], Buffer.byteLength('{}') + Buffer.byteLength('keep'))
  })

  it('records no checkpoint for an entry whose detail is not a JSON object', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: 'not-json' }, { Detail: '{"id":2}' }] },
    }

    captureLog('error', () => publishRequest(request))

    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0][2], Buffer.byteLength('{"id":2}'))
  })

  it('gives every batched entry its own trace context and pathway', () => {
    const calls = []
    buildChannelPlugin({
      batchPropagationEnabled: true,
      dsmEnabled: true,
      setCheckpoint: recordingCheckpoint(calls),
    })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: '{"id":1}', DetailType: 'invoice.created' },
          { Detail: '{"id":2}', DetailType: 'invoice.paid' },
        ],
      },
    }

    publishRequest(request)

    const first = injectedContext(request.params.Entries[0])
    const second = injectedContext(request.params.Entries[1])
    const expectedKeys = [...Object.keys(TRACE_CONTEXT), 'dd-pathway-ctx-base64']
    assert.deepStrictEqual(Object.keys(first), expectedKeys)
    assert.deepStrictEqual(Object.keys(second), expectedKeys)
    assert.notStrictEqual(second['dd-pathway-ctx-base64'], first['dd-pathway-ctx-base64'])
    assert.deepStrictEqual(calls.map(call => call[0][2]), ['topic:invoice.created', 'topic:invoice.paid'])
  })

  it('tags the checkpoint with the event bus and detail type', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [{
          Detail: '{"id":1}',
          DetailType: 'invoice.created',
          EventBusName: 'payments',
        }],
      },
    }

    publishRequest(request)

    assert.deepStrictEqual(calls[0][0],
      ['direction:out', 'exchange:payments', 'topic:invoice.created', 'type:eventbridge'])
  })

  it('tags the checkpoint with the default event bus and an empty detail type', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: '{"id":1}', DetailType: '', EventBusName: '' }] },
    }

    publishRequest(request)

    assert.deepStrictEqual(calls[0][0],
      ['direction:out', 'exchange:default', 'topic:', 'type:eventbridge'])
  })

  it('tags the checkpoint with the default detail type when omitted', () => {
    const calls = []
    buildChannelPlugin({ dsmEnabled: true, setCheckpoint: recordingCheckpoint(calls) })
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: '{"id":1}', EventBusName: 'payments' }] },
    }

    publishRequest(request)

    assert.deepStrictEqual(calls[0][0],
      ['direction:out', 'exchange:payments', 'topic:unknown', 'type:eventbridge'])
  })
})
