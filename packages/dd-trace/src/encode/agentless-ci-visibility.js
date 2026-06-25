'use strict'
const { version: ddTraceVersion } = require('../../../../package.json')
const { ITR_CORRELATION_ID, TEST_LEVELS_METADATA } = require('../../src/plugins/util/test')
const {
  CI_JOB_ID,
  CI_JOB_NAME,
  CI_JOB_URL,
  CI_NODE_LABELS,
  CI_NODE_NAME,
  CI_PIPELINE_ID,
  CI_PIPELINE_NAME,
  CI_PIPELINE_NUMBER,
  CI_PIPELINE_URL,
  CI_PROVIDER_NAME,
  CI_STAGE_NAME,
  CI_WORKSPACE_PATH,
  GIT_BRANCH,
  GIT_COMMIT_AUTHOR_DATE,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME,
  GIT_COMMIT_COMMITTER_DATE,
  GIT_COMMIT_COMMITTER_EMAIL,
  GIT_COMMIT_COMMITTER_NAME,
  GIT_COMMIT_HEAD_AUTHOR_DATE,
  GIT_COMMIT_HEAD_AUTHOR_EMAIL,
  GIT_COMMIT_HEAD_AUTHOR_NAME,
  GIT_COMMIT_HEAD_COMMITTER_DATE,
  GIT_COMMIT_HEAD_COMMITTER_EMAIL,
  GIT_COMMIT_HEAD_COMMITTER_NAME,
  GIT_COMMIT_HEAD_MESSAGE,
  GIT_COMMIT_HEAD_SHA,
  GIT_COMMIT_MESSAGE,
  GIT_COMMIT_SHA,
  GIT_PULL_REQUEST_BASE_BRANCH,
  GIT_PULL_REQUEST_BASE_BRANCH_HEAD_SHA,
  GIT_PULL_REQUEST_BASE_BRANCH_SHA,
  GIT_REPOSITORY_URL,
  GIT_TAG,
} = require('../../src/plugins/util/tags')
const id = require('../../src/id')
const {
  distributionMetric,
  TELEMETRY_ENDPOINT_PAYLOAD_SERIALIZATION_MS,
  TELEMETRY_ENDPOINT_PAYLOAD_EVENTS_COUNT,
} = require('../ci-visibility/telemetry')
const { MsgpackChunk } = require('../msgpack')
const { AgentEncoder } = require('./0.4')
const {
  truncateSpanTestOpt,
  normalizeSpan,
  MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION,
} = require('./tags-processors')

const ENCODING_VERSION = 1
const ALLOWED_CONTENT_TYPES = new Set(['test_session_end', 'test_module_end', 'test_suite_end', 'test'])
const ALLOWED_METADATA_TARGETS = new Set([...ALLOWED_CONTENT_TYPES, TEST_LEVELS_METADATA])

const TEST_SUITE_KEYS_LENGTH = 12
const TEST_MODULE_KEYS_LENGTH = 11
const TEST_SESSION_KEYS_LENGTH = 10
const TEST_AND_SPAN_KEYS_LENGTH = 11

const INTAKE_SOFT_LIMIT = 2 * 1024 * 1024 // 2MB

// Prefix is ~1 KB in practice; `MsgpackChunk` resizes on overflow.
const PREFIX_CHUNK_INITIAL_SIZE = 2048
const COMMON_TEST_LEVEL_METADATA_TAGS = new Set([
  CI_JOB_ID,
  CI_JOB_NAME,
  CI_JOB_URL,
  CI_NODE_LABELS,
  CI_NODE_NAME,
  CI_PIPELINE_ID,
  CI_PIPELINE_NAME,
  CI_PIPELINE_NUMBER,
  CI_PIPELINE_URL,
  CI_PROVIDER_NAME,
  CI_STAGE_NAME,
  CI_WORKSPACE_PATH,
  GIT_BRANCH,
  GIT_COMMIT_AUTHOR_DATE,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME,
  GIT_COMMIT_COMMITTER_DATE,
  GIT_COMMIT_COMMITTER_EMAIL,
  GIT_COMMIT_COMMITTER_NAME,
  GIT_COMMIT_HEAD_AUTHOR_DATE,
  GIT_COMMIT_HEAD_AUTHOR_EMAIL,
  GIT_COMMIT_HEAD_AUTHOR_NAME,
  GIT_COMMIT_HEAD_COMMITTER_DATE,
  GIT_COMMIT_HEAD_COMMITTER_EMAIL,
  GIT_COMMIT_HEAD_COMMITTER_NAME,
  GIT_COMMIT_HEAD_MESSAGE,
  GIT_COMMIT_HEAD_SHA,
  GIT_COMMIT_MESSAGE,
  GIT_COMMIT_SHA,
  GIT_PULL_REQUEST_BASE_BRANCH,
  GIT_PULL_REQUEST_BASE_BRANCH_HEAD_SHA,
  GIT_PULL_REQUEST_BASE_BRANCH_SHA,
  GIT_REPOSITORY_URL,
  GIT_TAG,
])
const hasOwn = Object.prototype.hasOwnProperty

function formatSpan (span) {
  let encodingVersion = ENCODING_VERSION
  if (span.type === 'test' && span.meta && span.meta.test_session_id) {
    encodingVersion = 2
  }
  return {
    type: ALLOWED_CONTENT_TYPES.has(span.type) ? span.type : 'span',
    version: encodingVersion,
    content: normalizeSpan(truncateSpanTestOpt(span)),
  }
}

function isAllowedMetadataTarget (target) {
  return ALLOWED_METADATA_TARGETS.has(target)
}

function isCommonTestLevelMetadataTag (key) {
  return COMMON_TEST_LEVEL_METADATA_TAGS.has(key)
}

function isEncodableMetadataValue (value) {
  return typeof value === 'string' || typeof value === 'number'
}

function truncateTestLevelMetadataValue (value) {
  if (typeof value !== 'string' || value.length <= MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION) {
    return value
  }
  return `${value.slice(0, MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION)}...`
}

function truncateTestLevelMetadataTags (tags) {
  const truncatedTags = {}
  let hasTags = false
  for (const key of Object.keys(tags)) {
    const value = truncateTestLevelMetadataValue(tags[key])
    if (!isEncodableMetadataValue(value)) continue
    truncatedTags[key] = value
    hasTags = true
  }
  return hasTags ? truncatedTags : undefined
}

class AgentlessCiVisibilityEncoder extends AgentEncoder {
  constructor (writer, { runtimeId, service, env }) {
    super(writer, INTAKE_SOFT_LIMIT)
    this.runtimeId = runtimeId
    this.service = service
    this.env = env

    // Used to keep track of the number of encoded events to update the
    // length of `payload.events` when calling `makePayload`
    this._eventCount = 0

    this.metadataTags = {}
    this.wildcardMetadataTags = {}

    this.reset()
  }

  addMetadataTags (tags) {
    if (tags['*']) {
      this.wildcardMetadataTags = {
        ...this.wildcardMetadataTags,
        ...tags['*'],
      }
    }

    for (const target of Object.keys(tags)) {
      if (target === '*' || !tags[target] || !isAllowedMetadataTarget(target)) continue

      const targetTags = target === TEST_LEVELS_METADATA
        ? truncateTestLevelMetadataTags(tags[target])
        : tags[target]
      if (!targetTags) continue

      this.metadataTags[target] = {
        ...this.metadataTags[target],
        ...targetTags,
      }
    }
  }

  _getTestLevelsMetadataTags () {
    let testLevelsMetadataTags = this.metadataTags[TEST_LEVELS_METADATA]
    if (!testLevelsMetadataTags) {
      testLevelsMetadataTags = {}
      this.metadataTags[TEST_LEVELS_METADATA] = testLevelsMetadataTags
    }
    return testLevelsMetadataTags
  }

  _promoteCommonTestLevelMetadata (event) {
    if (!ALLOWED_CONTENT_TYPES.has(event.type)) return

    const meta = event.content.meta
    if (!meta) return

    let testLevelsMetadataTags
    for (const key of Object.keys(meta)) {
      if (!isCommonTestLevelMetadataTag(key)) continue

      const value = truncateTestLevelMetadataValue(meta[key])
      if (!isEncodableMetadataValue(value)) continue

      if (!testLevelsMetadataTags) {
        testLevelsMetadataTags = this._getTestLevelsMetadataTags()
      }

      if (!hasOwn.call(testLevelsMetadataTags, key)) {
        testLevelsMetadataTags[key] = value
        delete meta[key]
      } else if (testLevelsMetadataTags[key] === value) {
        delete meta[key]
      } else {
        meta[key] = value
      }
    }
  }

  _encodeTestSuite (bytes, content) {
    let keysLength = TEST_SUITE_KEYS_LENGTH
    const itrCorrelationId = content.meta[ITR_CORRELATION_ID]
    if (itrCorrelationId) {
      keysLength++
    }

    bytes.writeMapPrefix(keysLength)
    this._encodeString(bytes, 'type')
    this._encodeString(bytes, content.type)

    this._encodeString(bytes, 'test_session_id')
    this._encodeId(bytes, content.trace_id)

    this._encodeString(bytes, 'test_module_id')
    this._encodeId(bytes, content.parent_id)

    this._encodeString(bytes, 'test_suite_id')
    this._encodeId(bytes, content.span_id)

    if (itrCorrelationId) {
      this._encodeString(bytes, ITR_CORRELATION_ID)
      this._encodeString(bytes, itrCorrelationId)
      delete content.meta[ITR_CORRELATION_ID]
    }

    this._encodeString(bytes, 'error')
    bytes.writeNumber(content.error)
    this._encodeString(bytes, 'name')
    this._encodeString(bytes, content.name)
    this._encodeString(bytes, 'service')
    this._encodeString(bytes, content.service)
    this._encodeString(bytes, 'resource')
    this._encodeString(bytes, content.resource)
    this._encodeString(bytes, 'start')
    bytes.writeNumber(content.start)
    this._encodeString(bytes, 'duration')
    bytes.writeNumber(content.duration)
    this._encodeString(bytes, 'meta')
    this._encodeMap(bytes, content.meta)
    this._encodeString(bytes, 'metrics')
    this._encodeMap(bytes, content.metrics)
  }

  _encodeTestModule (bytes, content) {
    bytes.writeMapPrefix(TEST_MODULE_KEYS_LENGTH)
    this._encodeString(bytes, 'type')
    this._encodeString(bytes, content.type)

    this._encodeString(bytes, 'test_session_id')
    this._encodeId(bytes, content.trace_id)

    this._encodeString(bytes, 'test_module_id')
    this._encodeId(bytes, content.span_id)

    this._encodeString(bytes, 'error')
    bytes.writeNumber(content.error)
    this._encodeString(bytes, 'name')
    this._encodeString(bytes, content.name)
    this._encodeString(bytes, 'service')
    this._encodeString(bytes, content.service)
    this._encodeString(bytes, 'resource')
    this._encodeString(bytes, content.resource)
    this._encodeString(bytes, 'start')
    bytes.writeNumber(content.start)
    this._encodeString(bytes, 'duration')
    bytes.writeNumber(content.duration)
    this._encodeString(bytes, 'meta')
    this._encodeMap(bytes, content.meta)
    this._encodeString(bytes, 'metrics')
    this._encodeMap(bytes, content.metrics)
  }

  _encodeTestSession (bytes, content) {
    bytes.writeMapPrefix(TEST_SESSION_KEYS_LENGTH)
    this._encodeString(bytes, 'type')
    this._encodeString(bytes, content.type)

    this._encodeString(bytes, 'test_session_id')
    this._encodeId(bytes, content.trace_id)

    this._encodeString(bytes, 'error')
    bytes.writeNumber(content.error)
    this._encodeString(bytes, 'name')
    this._encodeString(bytes, content.name)
    this._encodeString(bytes, 'service')
    this._encodeString(bytes, content.service)
    this._encodeString(bytes, 'resource')
    this._encodeString(bytes, content.resource)
    this._encodeString(bytes, 'start')
    bytes.writeNumber(content.start)
    this._encodeString(bytes, 'duration')
    bytes.writeNumber(content.duration)
    this._encodeString(bytes, 'meta')
    this._encodeMap(bytes, content.meta)
    this._encodeString(bytes, 'metrics')
    this._encodeMap(bytes, content.metrics)
  }

  _encodeEventContent (bytes, content) {
    let totalKeysLength = TEST_AND_SPAN_KEYS_LENGTH
    if (content.meta.test_session_id) {
      totalKeysLength += 1
    }
    if (content.meta.test_module_id) {
      totalKeysLength += 1
    }
    if (content.meta.test_suite_id) {
      totalKeysLength += 1
    }
    const itrCorrelationId = content.meta[ITR_CORRELATION_ID]
    if (itrCorrelationId) {
      totalKeysLength += 1
    }
    if (content.type) {
      totalKeysLength += 1
    }
    bytes.writeMapPrefix(totalKeysLength)
    if (content.type) {
      this._encodeString(bytes, 'type')
      this._encodeString(bytes, content.type)
    }
    this._encodeString(bytes, 'trace_id')
    this._encodeId(bytes, content.trace_id)
    this._encodeString(bytes, 'span_id')
    this._encodeId(bytes, content.span_id)
    this._encodeString(bytes, 'parent_id')
    this._encodeId(bytes, content.parent_id)
    this._encodeString(bytes, 'name')
    this._encodeString(bytes, content.name)
    this._encodeString(bytes, 'resource')
    this._encodeString(bytes, content.resource)
    this._encodeString(bytes, 'service')
    this._encodeString(bytes, content.service)
    this._encodeString(bytes, 'error')
    bytes.writeNumber(content.error)
    this._encodeString(bytes, 'start')
    bytes.writeNumber(content.start)
    this._encodeString(bytes, 'duration')
    bytes.writeNumber(content.duration)
    /**
     * We include `test_session_id` and `test_suite_id`
     * in the root of the event by passing them via the `meta` dict.
     * This is to avoid changing the span format in packages/dd-trace/src/format.js,
     * which can have undesired side effects in other products.
     * But `test_session_id` and `test_suite_id` are *not* supposed to be in `meta`,
     * so we delete them before enconding the dictionary.
     * TODO: find a better way to do this.
     */
    if (content.meta.test_session_id) {
      this._encodeString(bytes, 'test_session_id')
      this._encodeId(bytes, id(content.meta.test_session_id, 10))
      delete content.meta.test_session_id
    }

    if (content.meta.test_module_id) {
      this._encodeString(bytes, 'test_module_id')
      this._encodeId(bytes, id(content.meta.test_module_id, 10))
      delete content.meta.test_module_id
    }

    if (content.meta.test_suite_id) {
      this._encodeString(bytes, 'test_suite_id')
      this._encodeId(bytes, id(content.meta.test_suite_id, 10))
      delete content.meta.test_suite_id
    }

    if (itrCorrelationId) {
      this._encodeString(bytes, ITR_CORRELATION_ID)
      this._encodeString(bytes, itrCorrelationId)
      delete content.meta[ITR_CORRELATION_ID]
    }

    this._encodeString(bytes, 'meta')
    this._encodeMap(bytes, content.meta)
    this._encodeString(bytes, 'metrics')
    this._encodeMap(bytes, content.metrics)
  }

  _encodeEvent (bytes, event) {
    bytes.writeMapPrefix(Object.keys(event).length)
    this._encodeString(bytes, 'type')
    this._encodeString(bytes, event.type)

    this._encodeString(bytes, 'version')
    bytes.writeNumber(event.version)

    this._encodeString(bytes, 'content')
    if (event.type === 'span' || event.type === 'test') {
      this._encodeEventContent(bytes, event.content)
    } else if (event.type === 'test_suite_end') {
      this._encodeTestSuite(bytes, event.content)
    } else if (event.type === 'test_module_end') {
      this._encodeTestModule(bytes, event.content)
    } else if (event.type === 'test_session_end') {
      this._encodeTestSession(bytes, event.content)
    }
  }

  _encode (bytes, trace) {
    const startTime = Date.now()

    const events = trace.map(formatSpan)

    this._eventCount += events.length

    for (const event of events) {
      this._promoteCommonTestLevelMetadata(event)
      this._encodeEvent(bytes, event)
    }
    distributionMetric(
      TELEMETRY_ENDPOINT_PAYLOAD_SERIALIZATION_MS,
      { endpoint: 'test_cycle' },
      Date.now() - startTime
    )
  }

  makePayload () {
    distributionMetric(TELEMETRY_ENDPOINT_PAYLOAD_EVENTS_COUNT, { endpoint: 'test_cycle' }, this._eventCount)

    // Encode the payload prefix (version + metadata + events-array header) at flush time,
    // not on the first `_encode`. The CI Visibility flow adds metadata across multiple
    // diagnostic channels (`session:start` adds `test_session.name`, the async
    // `library-configuration` callback adds capability tags). Any span finished between
    // those calls would otherwise freeze the prefix with stale metadata.
    const prefixBytes = new MsgpackChunk(PREFIX_CHUNK_INITIAL_SIZE)
    this._encodePayloadStart(prefixBytes)

    const eventsOffset = this._eventsOffset
    const eventsCount = this._eventCount
    prefixBytes.buffer[eventsOffset] = 0xDD
    prefixBytes.buffer[eventsOffset + 1] = eventsCount >> 24
    prefixBytes.buffer[eventsOffset + 2] = eventsCount >> 16
    prefixBytes.buffer[eventsOffset + 3] = eventsCount >> 8
    prefixBytes.buffer[eventsOffset + 4] = eventsCount

    const eventsBytes = this._traceBytes
    const totalSize = prefixBytes.length + eventsBytes.length
    const buffer = Buffer.allocUnsafe(totalSize)
    prefixBytes.buffer.copy(buffer, 0, 0, prefixBytes.length)
    eventsBytes.buffer.copy(buffer, prefixBytes.length, 0, eventsBytes.length)

    this.reset()

    return buffer
  }

  _encodePayloadStart (bytes) {
    // Encodes the payload up to (and including) the `events` array prefix. The 5 reserved
    // bytes for the array length are patched in `makePayload`.
    const payload = {
      version: ENCODING_VERSION,
      metadata: {
        '*': {
          language: 'javascript',
          library_version: ddTraceVersion,
          ...this.wildcardMetadataTags,
        },
        ...this.metadataTags,
      },
      events: [],
    }

    if (this.env) {
      payload.metadata['*'].env = this.env
    }
    if (this.runtimeId) {
      payload.metadata['*']['runtime-id'] = this.runtimeId
    }

    bytes.writeMapPrefix(Object.keys(payload).length)
    this._encodeString(bytes, 'version')
    bytes.writeNumber(payload.version)
    this._encodeString(bytes, 'metadata')
    const metadataKeys = Object.keys(payload.metadata)
    bytes.writeMapPrefix(metadataKeys.length)
    for (const metadataKey of metadataKeys) {
      this._encodeString(bytes, metadataKey)
      this._encodeMap(bytes, payload.metadata[metadataKey])
    }
    this._encodeString(bytes, 'events')
    this._eventsOffset = bytes.length
    bytes.reserve(5)
  }

  reset () {
    this._reset()
    this._eventCount = 0
  }
}

module.exports = { AgentlessCiVisibilityEncoder }
