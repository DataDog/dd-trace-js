# Data Streams Monitoring (DSM) Code Path

This document is a handoff note for another agent. It identifies the exact code paths in `dd-trace-js` that:

1. create DSM checkpoints
2. propagate DSM pathway context
3. bucket and serialize DSM stats
4. send DSM payloads to the Datadog agent endpoint

## Short answer

The core DSM implementation lives under `packages/dd-trace/src/datastreams/`.

- Checkpoints are generated in `packages/dd-trace/src/datastreams/processor.js`
- DSM context propagation is encoded/decoded in `packages/dd-trace/src/datastreams/pathway.js`
- Periodic payload flush happens in `packages/dd-trace/src/datastreams/processor.js`
- Agent transport is in `packages/dd-trace/src/datastreams/writer.js`
- The underlying HTTP client is the shared exporter request path in `packages/dd-trace/src/exporters/common/request.js`

The most important endpoint is:

- `POST /v0.1/pipeline_stats`

## End-to-end flow

Typical automatic DSM flow for a messaging integration:

1. A plugin calls `tracer.setCheckpoint(...)`
2. `tracer.setCheckpoint(...)` forwards to `DataStreamsManager.setCheckpoint(...)`
3. `DataStreamsManager.setCheckpoint(...)` calls `DataStreamsProcessor.setCheckpoint(...)`
4. `DataStreamsProcessor.setCheckpoint(...)` computes the pathway hash and records the checkpoint
5. The integration usually injects the DSM header with `DsmPathwayCodec.encode(...)`
6. On a timer, `DataStreamsProcessor.onInterval()` serializes accumulated buckets
7. `DataStreamsWriter.flush(...)` msgpacks and gzips the payload
8. `DataStreamsWriter` sends it to the agent at `POST /v0.1/pipeline_stats`

Important behavior:

- Checkpoints are not sent immediately
- They are accumulated into 10 second buckets (`bucketSizeNs = 1e10`)
- Flush happens on the DSM interval timer and again on process exit through `beforeExitHandlers`

## Tracer entry points

The tracer wires DSM up here:

File: `packages/dd-trace/src/tracer.js`

```js
class DatadogTracer extends Tracer {
  constructor (config, prioritySampler) {
    super(config, prioritySampler)
    this._dataStreamsProcessor = new DataStreamsProcessor(config)
    this._dataStreamsManager = new DataStreamsManager(this._dataStreamsProcessor)
    this.dataStreamsCheckpointer = new DataStreamsCheckpointer(this)
  }

  setCheckpoint (edgeTags, span, payloadSize = 0) {
    return this._dataStreamsManager.setCheckpoint(edgeTags, span, payloadSize)
  }

  decodeDataStreamsContext (carrier) {
    return this._dataStreamsManager.decodeDataStreamsContext(carrier)
  }

  setOffset (offsetData) {
    return this._dataStreamsProcessor.setOffset(offsetData)
  }

  setUrl (url) {
    this._exporter.setUrl(url)
    this._dataStreamsProcessor.setUrl(url)
  }
}
```

## Checkpoint creation

The exact checkpoint generation logic is here:

File: `packages/dd-trace/src/datastreams/processor.js`

```js
setCheckpoint (edgeTags, span, ctx, payloadSize = 0) {
  if (!this.enabled) return
  const nowNs = Date.now() * 1e6
  const direction = edgeTags[0]
  let pathwayStartNs = nowNs
  let edgeStartNs = nowNs
  let parentHash = ENTRY_PARENT_HASH
  let closestOppositeDirectionHash = ENTRY_PARENT_HASH
  let closestOppositeDirectionEdgeStart = nowNs

  if (ctx == null) {
    log.debug('Setting DSM Checkpoint with empty parent context.')
  } else {
    pathwayStartNs = ctx.pathwayStartNs
    edgeStartNs = ctx.edgeStartNs
    parentHash = ctx.hash
    closestOppositeDirectionHash = ctx.closestOppositeDirectionHash || ENTRY_PARENT_HASH
    closestOppositeDirectionEdgeStart = ctx.closestOppositeDirectionEdgeStart || nowNs

    if (direction === ctx.previousDirection) {
      parentHash = ctx.closestOppositeDirectionHash
      if (parentHash === ENTRY_PARENT_HASH) {
        edgeStartNs = nowNs
        pathwayStartNs = nowNs
      } else {
        edgeStartNs = ctx.closestOppositeDirectionEdgeStart
      }
    } else {
      closestOppositeDirectionHash = parentHash
      closestOppositeDirectionEdgeStart = edgeStartNs
    }
  }

  const propagationHashValue = propagationHash.isEnabled() ? propagationHash.getHash() : null

  const hash = computePathwayHash(this.service, this.env, edgeTags, parentHash, propagationHashValue)
  const edgeLatencyNs = nowNs - edgeStartNs
  const pathwayLatencyNs = nowNs - pathwayStartNs
  const dataStreamsContext = {
    hash,
    edgeStartNs,
    pathwayStartNs,
    previousDirection: direction,
    closestOppositeDirectionHash,
    closestOppositeDirectionEdgeStart,
  }

  if (direction === 'direction:out') {
    payloadSize += PATHWAY_HEADER_BYTES
  }

  const checkpoint = {
    currentTimestamp: nowNs,
    parentHash,
    hash,
    edgeTags,
    edgeLatencyNs,
    pathwayLatencyNs,
    payloadSize,
  }

  this.recordCheckpoint(checkpoint, span)
  return dataStreamsContext
}
```

What this does:

- computes the current checkpoint timestamp
- derives parent pathway state from any previously extracted DSM context
- computes the pathway hash with `computePathwayHash(...)`
- calculates edge latency and pathway latency
- records the checkpoint into a time bucket
- returns the new DSM context so it can be propagated downstream

Checkpoint recording lands here:

```js
recordCheckpoint (checkpoint, span = null) {
  if (!this.enabled) return
  const statsPoint = this.bucketFromTimestamp(checkpoint.currentTimestamp).forCheckpoint(checkpoint)
  statsPoint.addLatencies(checkpoint)
  if (span) {
    span.setTag(PATHWAY_HASH, statsPoint.hash.toString())
  }
}
```

## Hashing and DSM context propagation

Pathway hash and header encoding live here:

File: `packages/dd-trace/src/datastreams/pathway.js`

### Pathway hash

```js
function computeHash (service, env, edgeTags, parentHash, propagationHashBigInt = null) {
  edgeTags.sort()
  const hashableEdgeTags = edgeTags.includes('manual_checkpoint:true')
    ? edgeTags.filter(item => item !== 'manual_checkpoint:true')
    : edgeTags

  const joinedEdgeTags = hashableEdgeTags.join('')
  const propagationHex = propagationHashBigInt ? propagationHashBigInt.toString(16) : ''
  const propagationPart = propagationHex ? `:${propagationHex}` : ''
  const key = `${service}${env}${joinedEdgeTags}${parentHash}${propagationPart}`

  let value = cache.get(key)
  if (value) {
    return value
  }

  const baseString = `${service}${env}${joinedEdgeTags}`
  const hashInput = propagationHex ? `${baseString}:${propagationHex}` : baseString

  const currentHash = shaHash(hashInput)
  const buf = Buffer.concat([currentHash, parentHash], 16)
  value = shaHash(buf.toString())
  cache.set(key, value)
  return value
}
```

### DSM header injection

```js
const DsmPathwayCodec = {
  encode (dataStreamsContext, carrier) {
    if (!dataStreamsContext || !dataStreamsContext.hash) {
      return
    }
    carrier[CONTEXT_PROPAGATION_KEY_BASE64] = encodePathwayContextBase64(dataStreamsContext)
  },

  decode (carrier) {
    if (carrier == null) return

    let ctx
    if (CONTEXT_PROPAGATION_KEY_BASE64 in carrier) {
      ctx = decodePathwayContextBase64(carrier[CONTEXT_PROPAGATION_KEY_BASE64])
    } else if (CONTEXT_PROPAGATION_KEY in carrier) {
      try {
        ctx = decodePathwayContext(carrier[CONTEXT_PROPAGATION_KEY])
      } catch {
      }
      if (!ctx && CONTEXT_PROPAGATION_KEY in carrier) {
        ctx = decodePathwayContextBase64(carrier[CONTEXT_PROPAGATION_KEY])
      }
    }

    return ctx
  },
}
```

Important carrier key:

- `dd-pathway-ctx-base64`

## Serialization and periodic flush

The periodic flush happens here:

File: `packages/dd-trace/src/datastreams/processor.js`

```js
onInterval () {
  const { Stats } = this._serializeBuckets()
  if (Stats.length === 0) return

  const payload = {
    Env: this.env,
    Service: this.service,
    Stats,
    TracerVersion: pkg.version,
    Version: this.version,
    Lang: 'javascript',
    Tags: Object.entries(this.tags).map(([key, value]) => `${key}:${value}`),
  }

  if (propagationHash.isEnabled() && processTags.serialized) {
    payload.ProcessTags = processTags.serialized.split(',')
  }

  this.writer.flush(payload)
}
```

Serialization of bucket contents happens here:

```js
_serializeBuckets () {
  const serializedBuckets = []
  const registrySnapshot = this._checkpointRegistry.encodedKeys

  for (const [timeNs, bucket] of this.buckets.entries()) {
    const points = []
    for (const stats of bucket._checkpoints.values()) {
      points.push(stats.encode())
    }

    const backlogs = []
    for (const backlog of bucket._backlogs.values()) {
      backlogs.push(backlog.encode())
    }

    const serializedBucket = {
      Start: BigInt(timeNs),
      Duration: BigInt(this.bucketSizeNs),
      Stats: points,
      Backlogs: backlogs,
    }

    const transactions = bucket.transactions
    if (transactions !== null) {
      serializedBucket.Transactions = transactions
      serializedBucket.TransactionCheckpointIds = registrySnapshot
    }

    serializedBuckets.push(serializedBucket)
  }

  this.buckets.clear()

  return {
    Stats: serializedBuckets,
  }
}
```

The stats point shape comes from `StatsPoint.encode()`:

```js
encode () {
  return {
    Hash: this.hash,
    ParentHash: this.parentHash,
    EdgeTags: this.edgeTags,
    EdgeLatency: this.edgeLatency.toProto(),
    PathwayLatency: this.pathwayLatency.toProto(),
    PayloadSize: this.payloadSize.toProto(),
  }
}
```

## Send to the agent endpoint

The DSM writer is here:

File: `packages/dd-trace/src/datastreams/writer.js`

```js
function makeRequest (data, url, cb) {
  const options = {
    path: '/v0.1/pipeline_stats',
    method: 'POST',
    headers: {
      'Datadog-Meta-Lang': 'javascript',
      'Datadog-Meta-Tracer-Version': pkg.version,
      'Content-Type': 'application/msgpack',
      'Content-Encoding': 'gzip',
    },
    url,
  }

  request(data, options, (err, res) => {
    cb(err, res)
  })
}
```

And the actual flush:

```js
class DataStreamsWriter {
  constructor (config) {
    this._url = config.url
  }

  flush (payload) {
    if (!request.writable) {
      log.debug('Maximum number of active requests reached. Payload discarded: %j', payload)
      return
    }
    const encodedPayload = encodeMsgpack(payload)

    zlib.gzip(encodedPayload, { level: 1 }, (err, compressedData) => {
      if (err) {
        log.error('Error zipping datastream', err)
        return
      }
      makeRequest(compressedData, this._url, (err, res) => {
        log.debug('Response from the agent:', res)
        if (err) {
          log.error('Error sending datastream', err)
        }
      })
    })
  }
}
```

That `request(...)` call is the shared HTTP path in:

- `packages/dd-trace/src/exporters/common/request.js`

Core part:

```js
function request (data, options, callback) {
  if (options.url) {
    const url = parseUrl(options.url)
    if (url.protocol === 'unix:') {
      options.socketPath = url.pathname
    } else {
      if (!options.path) options.path = url.path
      options.protocol = url.protocol
      options.hostname = url.hostname
      options.port = url.port
    }
  }

  const isSecure = options.protocol === 'https:'
  const client = isSecure ? https : http

  const req = client.request(options, (res) => onResponse(res, finalize))
  // ...
}
```

So the DSM payload is:

1. msgpack encoded
2. gzip compressed
3. sent through the shared exporter HTTP request path
4. posted to `/v0.1/pipeline_stats`

## Manual DSM API

There is also a manual checkpointer API:

File: `packages/dd-trace/src/datastreams/checkpointer.js`

### Produce checkpoint

```js
setProduceCheckpoint (type, target, carrier) {
  if (!this.config.dsmEnabled) return

  const ctx = this.dsmProcessor.setCheckpoint(
    ['direction:out', 'type:' + type, 'topic:' + target, 'manual_checkpoint:true'],
    null,
    DataStreamsContext.getDataStreamsContext()
  )
  DataStreamsContext.setDataStreamsContext(ctx)

  this.tracer.inject(ctx, 'text_map_dsm', carrier)
}
```

### Consume checkpoint

```js
setConsumeCheckpoint (type, source, carrier, manualCheckpoint = true) {
  if (!this.config.dsmEnabled) return

  const parentCtx = this.tracer.extract('text_map_dsm', carrier)
  DataStreamsContext.setDataStreamsContext(parentCtx)

  const tags = ['direction:in', 'type:' + type, 'topic:' + source]
  if (manualCheckpoint) {
    tags.push('manual_checkpoint:true')
  }

  const ctx = this.dsmProcessor.setCheckpoint(tags, null, parentCtx)
  DataStreamsContext.setDataStreamsContext(ctx)

  return ctx
}
```

The DSM-specific text map propagator used by that path is:

- `packages/dd-trace/src/opentracing/propagation/text_map_dsm.js`

```js
inject (ctx, carrier) {
  if (!this.config.dsmEnabled) return
  DsmPathwayCodec.encode(ctx, carrier)
}

extract (carrier) {
  if (!this.config.dsmEnabled) return
  return DsmPathwayCodec.decode(carrier)
}
```

## Representative plugin call sites

KafkaJS is a good concrete example of where the core DSM code gets used.

### Producer

File: `packages/datadog-plugin-kafkajs/src/producer.js`

```js
const payloadSize = getMessageSize(message)
const edgeTags = ['direction:out', `topic:${topic}`, 'type:kafka']

if (clusterId) {
  edgeTags.push(`kafka_cluster_id:${clusterId}`)
}

const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)
if (!disableHeaderInjection) {
  DsmPathwayCodec.encode(dataStreamsContext, message.headers)
}
```

### Consumer

File: `packages/datadog-plugin-kafkajs/src/consumer.js`

```js
const { span } = ctx.currentStore
const payloadSize = getMessageSize(message)
this.tracer.decodeDataStreamsContext(headers)
const edgeTags = ['direction:in', `group:${groupId}`, `topic:${topic}`, 'type:kafka']
if (clusterId) {
  edgeTags.push(`kafka_cluster_id:${clusterId}`)
}
this.tracer.setCheckpoint(edgeTags, span, payloadSize)
```

Other integrations that use the same DSM primitives include:

- `packages/datadog-plugin-amqplib`
- `packages/datadog-plugin-bullmq`
- `packages/datadog-plugin-google-cloud-pubsub`
- `packages/datadog-plugin-rhea`
- `packages/datadog-plugin-aws-sdk/src/services/sqs.js`
- `packages/datadog-plugin-aws-sdk/src/services/sns.js`
- `packages/datadog-plugin-aws-sdk/src/services/kinesis.js`
- `packages/datadog-plugin-aws-sdk/src/services/eventbridge.js`

## Files to inspect first

If another agent only has a few minutes, these are the best entry points:

1. `packages/dd-trace/src/datastreams/processor.js`
2. `packages/dd-trace/src/datastreams/writer.js`
3. `packages/dd-trace/src/datastreams/pathway.js`
4. `packages/dd-trace/src/tracer.js`
5. `packages/datadog-plugin-kafkajs/src/producer.js`
6. `packages/datadog-plugin-kafkajs/src/consumer.js`
7. `packages/dd-trace/src/exporters/common/request.js`

## One-line summary

DSM checkpoints are generated in `DataStreamsProcessor.setCheckpoint(...)`, accumulated into 10 second buckets, serialized by `DataStreamsProcessor.onInterval()`, msgpacked and gzipped by `DataStreamsWriter.flush(...)`, and sent to the Datadog agent at `POST /v0.1/pipeline_stats`.
