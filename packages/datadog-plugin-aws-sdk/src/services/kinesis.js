'use strict'
const { DsmPathwayCodec, getSizeOrZero } = require('../../../dd-trace/src/datastreams')
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

function recordDataAsString (data) {
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
}

// Caps the promise-path iterator→stream cache so abandoned shard iterators
// (AWS expires them after 5 minutes) can't grow it without bound. Polling loops
// delete on consume, so their working set is ~the active shard count.
const MAX_TRACKED_SHARD_ITERATORS = 1000

// Kinesis rejects a record once its data blob reaches 1 MiB.
const KINESIS_MAX_RECORD_BYTES = 1_048_576

// The DSM pathway field (`dd-pathway-ctx-base64`) always serializes to a fixed 55 bytes: a
// 21-char key, a 28-char base64 value, and 6 bytes of JSON framing. Mirrors PATHWAY_HEADER_BYTES
// in dd-trace/src/datastreams/processor.js. Reserved in the size gate so setDSMCheckpoint never
// runs for a record that would ship over the cap once the pathway context is attached.
const DSM_PATHWAY_FIELD_BYTES = 55

class Kinesis extends BaseAwsSdkPlugin {
  static id = 'kinesis'
  static peerServicePrecursors = ['streamname']
  static isPayloadReporter = true

  #shardIteratorStreams = new Map()

  constructor (...args) {
    super(...args)

    // TODO(bengl) Find a way to create the response span tags without this WeakMap being populated
    // in the base class
    this.requestTags = new WeakMap()

    this.addBind('apm:aws:response:start:kinesis', ctx => this.#startResponseSpan(ctx))

    // Promise / event-emitter calls never publish response:start, so create and finish the
    // consumer span from request:complete instead. Callback calls handle it via the bind above.
    this.addSub('apm:aws:request:complete:kinesis', ctx => {
      if (ctx.cbExists) return
      // v2 nests the SDK payload under response.data; v3 spreads the output onto response.
      const response = ctx.response?.data ?? ctx.response
      const responseCtx = { request: ctx.request, response }
      this.#startResponseSpan(responseCtx)
      if (responseCtx.needsFinish) this.finish(responseCtx)
      // The async store that carries streamName to getRecords on the callback path is
      // absent here, so map each shard iterator to its stream for the DSM topic tag.
      if (this.config.dsmEnabled) this.#trackShardStream(ctx.request, response)
    })

    this.addSub('apm:aws:response:finish:kinesis', ctx => {
      if (!ctx.needsFinish) return
      this.finish(ctx)
    })
  }

  /**
   * @param {object} ctx Completion context carrying the SDK request and response.
   */
  #startResponseSpan (ctx) {
    const { request, response } = ctx

    let store = this._parentMap.get(request)

    // if we have either of these operations, we want to store the streamName param
    // since it is not typically available during get/put records requests
    if (request.operation === 'getShardIterator' || request.operation === 'listShards') {
      return this.storeStreamName(request.params, request.operation, store)
    }

    if (request.operation === 'getRecords') {
      let span
      const responseExtraction = this.responseExtract(request.params, request.operation, response)
      if (responseExtraction && responseExtraction.maybeChildOf) {
        ctx.needsFinish = true
        const options = {
          childOf: responseExtraction.maybeChildOf,
          meta: {
            ...this.requestTags.get(request),
            'span.kind': 'server',
          },
          integrationName: 'aws-sdk',
        }
        span = this.startSpan('aws.response', options, ctx)
        store = ctx.currentStore
      }

      if (this.config.dsmEnabled) {
        // streamName rides the async store on the callback path; the promise path has no
        // such link, so fall back to the iterator the producer returned.
        const streamName = store?.streamName ?? this.#shardIteratorStreams.get(request.params.ShardIterator)
        this.responseExtractDSMContext(request.operation, request.params, response, span || null, { streamName })
      }
    }

    return store
  }

  /**
   * @param {object} request SDK request; reads `operation` and `params`.
   * @param {object} response SDK output; reads `ShardIterator` / `NextShardIterator`.
   */
  #trackShardStream (request, response) {
    if (request.operation === 'getShardIterator') {
      this.#rememberShardStream(response?.ShardIterator, request.params?.StreamName)
    } else if (request.operation === 'getRecords') {
      this.#advanceShardStream(request.params?.ShardIterator, response?.NextShardIterator)
    }
  }

  /**
   * @param {string} [iterator] Shard iterator the producer returned.
   * @param {string} [streamName] Stream the iterator belongs to.
   */
  #rememberShardStream (iterator, streamName) {
    if (!iterator || streamName === undefined) return
    // FIFO-evict the oldest entry (Map keeps insertion order) when the cap is hit; only
    // abandoned iterators get here, so no realistic test drives the cap (eviction ignored).
    /* istanbul ignore if */
    if (this.#shardIteratorStreams.size >= MAX_TRACKED_SHARD_ITERATORS) {
      this.#shardIteratorStreams.delete(this.#shardIteratorStreams.keys().next().value)
    }
    this.#shardIteratorStreams.set(iterator, streamName)
  }

  /**
   * @param {string} [consumedIterator] Iterator just passed to getRecords.
   * @param {string} [nextIterator] NextShardIterator for the following poll.
   */
  #advanceShardStream (consumedIterator, nextIterator) {
    const streamName = this.#shardIteratorStreams.get(consumedIterator)
    if (streamName === undefined) return
    this.#shardIteratorStreams.delete(consumedIterator)
    // carry the stream onto the next iterator so the polling loop keeps its topic
    if (nextIterator) this.#rememberShardStream(nextIterator, streamName)
  }

  generateTags (params, operation, response) {
    if (!params || !params.StreamName) return

    return {
      'resource.name': `${operation} ${params.StreamName}`,
      'aws.kinesis.stream_name': params.StreamName,
      'messaging.system': 'aws_kinesis',
      streamname: params.StreamName,
    }
  }

  storeStreamName (params, operation, store) {
    if (!operation) return store
    if (operation !== 'getShardIterator' && operation !== 'listShards') return store
    if (!params || !params.StreamName) return store

    const streamName = params.StreamName
    return { ...store, streamName }
  }

  responseExtract (params, operation, response) {
    if (operation !== 'getRecords') return
    if (params.Limit && params.Limit !== 1) return
    if (!response || !response.Records || !response.Records[0]) return

    const record = response.Records[0]

    try {
      const decodedData = JSON.parse(recordDataAsString(record.Data))

      return {
        maybeChildOf: this.tracer.extract('text_map', decodedData._datadog),
        parsedAttributes: decodedData._datadog,
      }
    } catch (error) {
      log.error('Kinesis error extracting response', error)
    }
  }

  responseExtractDSMContext (operation, params, response, span, kwargs = {}) {
    const { streamName } = kwargs
    if (!this.config.dsmEnabled) return
    if (operation !== 'getRecords') return
    if (!response || !response.Records || !response.Records[0]) return

    // Only attribute payloadSize to the span when there is a single record.
    span = response.Records.length > 1 ? null : span

    const tags = streamName
      ? ['direction:in', `topic:${streamName}`, 'type:kinesis']
      : ['direction:in', 'type:kinesis']

    for (const record of response.Records) {
      let parsedAttributes
      try {
        parsedAttributes = JSON.parse(recordDataAsString(record.Data))
      } catch {
        // Non-JSON record. Skip DSM context for this entry; the
        // checkpoint payload size below is still reported.
      }

      const payloadSize = getSizeOrZero(record.Data)
      if (parsedAttributes?._datadog) {
        this.tracer.decodeDataStreamsContext(parsedAttributes._datadog)
      }
      this.tracer.setCheckpoint(tags, span, payloadSize)
    }
  }

  // AWS-SDK base64-encodes kinesis payloads but also accepts an already
  // base64-encoded payload; both shapes land here.
  _tryParse (body) {
    try {
      return JSON.parse(body)
    } catch {
      log.info('Not JSON string. Trying Base64 encoded JSON string')
    }
    try {
      return JSON.parse(Buffer.from(body, 'base64').toString('ascii'))
    } catch {
      return null
    }
  }

  requestInject (span, request) {
    const { operation, params } = request
    if (!params) return

    let stream
    switch (operation) {
      case 'putRecord':
        stream = params.StreamArn ?? params.StreamName ?? ''
        this.injectToMessage(span, params, stream, true)
        break
      case 'putRecords':
        stream = params.StreamArn ?? params.StreamName ?? ''
        for (let i = 0; i < params.Records.length; i++) {
          this.injectToMessage(
            span,
            params.Records[i],
            stream,
            i === 0 || this.config.batchPropagationEnabled
          )
        }
    }
  }

  injectToMessage (span, params, stream, injectTraceContext) {
    if (!params) {
      return
    }

    let parsedData
    if (injectTraceContext || this.config.dsmEnabled) {
      parsedData = this._tryParse(params.Data)
      if (!parsedData) {
        log.error('Unable to parse payload, unable to pass trace context or set DSM checkpoint (if enabled)')
        return
      }
    }

    const ddInfo = {}
    let injected = false
    // For now we only inject to the first message; batches may change later.
    if (injectTraceContext) {
      injected = this.tracer.inject(span, 'text_map', ddInfo)
    }

    const dsmEnabled = this.config.dsmEnabled
    if (!injected && !dsmEnabled) return

    parsedData._datadog = ddInfo
    // Gate on the 1 MiB Kinesis cap before setDSMCheckpoint: a record we can't ship must not
    // record a checkpoint. When DSM runs, reserve the fixed-size pathway field the encode below
    // appends after the gate, so a record that only fits without it records no checkpoint and
    // never gets written over the cap.
    let serialized = JSON.stringify(parsedData)
    const reservedBytes = dsmEnabled ? DSM_PATHWAY_FIELD_BYTES : 0
    if (Buffer.byteLength(serialized, 'utf8') + reservedBytes >= KINESIS_MAX_RECORD_BYTES) {
      log.info('Payload size too large to pass context')
      return
    }

    if (dsmEnabled) {
      const dataStreamsContext = this.setDSMCheckpoint(span, params, stream)
      if (dataStreamsContext) {
        DsmPathwayCodec.encode(dataStreamsContext, ddInfo)
        injected = true
        serialized = JSON.stringify(parsedData)
      }
    }

    if (!injected) return

    params.Data = Buffer.from(serialized, 'utf8')
  }

  setDSMCheckpoint (span, params, stream) {
    const payloadSize = getSizeOrZero(params.Data)
    return this.tracer
      .setCheckpoint(['direction:out', `topic:${stream}`, 'type:kinesis'], span, payloadSize)
  }
}

module.exports = Kinesis
