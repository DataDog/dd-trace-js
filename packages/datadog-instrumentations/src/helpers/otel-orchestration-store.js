'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const { getEnvironmentVariable } = require('../../../dd-trace/src/config/helper')
const {
  appendOrchestrationSpanToTraceState,
  getSpanMeta,
  parseOrchestrationMetaFromTraceContext,
} = require('./otel-orchestration-meta')
const {
  createOrchestrationMeta,
  createOrchestrationMetaFromHttpParent,
  exportOrchestrationSpanFromMeta,
} = require('./otel-orchestration-export')
const {
  applyHttpParentToMeta,
  resolveHttpParentForOrchestration,
} = require('./otel-orchestration-http-link')

const TABLE_NAME = 'DDAzureOrchestrationSpans'
const TABLE_PARTITION_KEY = 'orch'
const META_CACHE = new Map()

let tableClient
let tableClientResolved = false
let tableEnsured = false

function getStoreDirectory () {
  // Internal override for tests and local development only, so it is deliberately
  // not a registered configuration.
  // eslint-disable-next-line eslint-rules/eslint-process-env
  return process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR ||
    path.join(os.tmpdir(), 'dd-orchestration-spans')
}

function getMetaFilePath (instanceId) {
  return path.join(getStoreDirectory(), `${instanceId}.json`)
}

function writeMetaFileSync (instanceId, meta) {
  const directory = getStoreDirectory()
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(getMetaFilePath(instanceId), JSON.stringify(meta))
}

function readMetaFileSync (instanceId) {
  try {
    const contents = fs.readFileSync(getMetaFilePath(instanceId), 'utf8')
    return JSON.parse(contents)
  } catch {}
}

function deleteMetaFileSync (instanceId) {
  try {
    fs.unlinkSync(getMetaFilePath(instanceId))
  } catch {
    // ignore missing files
  }
}

function getAzuriteConnectionString () {
  return 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;' +
    'AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;' +
    'TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;'
}

function getTableClient () {
  if (tableClientResolved) return tableClient

  tableClientResolved = true
  tableClient = null

  const connectionString = getEnvironmentVariable('AzureWebJobsStorage')
  if (!connectionString) return null

  try {
    // Provided by the Azure Functions host, so it is never a tracer dependency.
    // eslint-disable-next-line n/no-missing-require
    const { TableClient } = require('@azure/data-tables')
    const resolvedConnectionString = connectionString === 'UseDevelopmentStorage=true'
      ? getAzuriteConnectionString()
      : connectionString
    tableClient = TableClient.fromConnectionString(resolvedConnectionString, TABLE_NAME)
  } catch {
    tableClient = null
  }

  return tableClient
}

async function ensureTable () {
  const client = getTableClient()
  if (!client || tableEnsured) return client

  try {
    await client.createTable()
  } catch (error) {
    if (error?.statusCode !== 409) throw error
  }

  tableEnsured = true
  return client
}

function normalizeMeta (meta) {
  if (!meta?.traceId || !meta?.spanId) return
  return meta
}

function publishOrchestrationMetaSync (instanceId, meta) {
  const normalized = normalizeMeta(meta)
  if (!instanceId || !normalized) return

  META_CACHE.set(instanceId, normalized)
  writeMetaFileSync(instanceId, normalized)

  const client = getTableClient()
  if (!client) return

  ensureTable()
    .then(table => table.upsertEntity({
      partitionKey: TABLE_PARTITION_KEY,
      rowKey: instanceId,
      traceId: normalized.traceId,
      spanId: normalized.spanId,
      parentId: normalized.parentId ?? '',
      httpParentSpanId: normalized.httpParentSpanId ?? '',
      functionName: normalized.functionName ?? '',
      pendingStart: normalized.pendingStart === true,
      startTime: normalized.startTime,
      status: normalized.status || 'open',
    }, 'Replace'))
    .catch(() => {})
}

function publishOrchestrationSpanMetaSync (instanceId, span) {
  const meta = getSpanMeta(span)
  if (!meta) return
  publishOrchestrationMetaSync(instanceId, {
    ...meta,
    startTime: Date.now(),
    status: 'open',
  })
}

function reconcileOrchestrationHttpParent (instanceId, httpParent) {
  if (!instanceId || !httpParent?.spanId) return

  const existing = readOrchestrationSpanMetaSync(instanceId)
  if (!existing?.traceId || !existing?.spanId) return

  const updated = applyHttpParentToMeta(existing, httpParent)
  if (updated.parentId === existing.parentId && updated.httpParentSpanId === existing.httpParentSpanId) {
    return existing
  }

  publishOrchestrationMetaSync(instanceId, updated)
  return updated
}

// Record the orchestration span identity while the HTTP span that started the
// instance is still available, so any worker that later runs the orchestration
// reads the HTTP span as its parent.
function seedOrchestrationMetaFromHttpParent (instanceId, httpParent, functionName) {
  if (!instanceId || !httpParent?.spanId) return

  const existing = readOrchestrationSpanMetaSync(instanceId)
  if (existing?.traceId && existing.spanId) {
    return reconcileOrchestrationHttpParent(instanceId, httpParent)
  }

  const meta = createOrchestrationMetaFromHttpParent(instanceId, httpParent, functionName)
  if (!meta) return

  publishOrchestrationMetaSync(instanceId, meta)
  return meta
}

function ensureOrchestrationMeta (instanceId, invocationContext, functionName) {
  const traceContext = invocationContext?.traceContext
  let meta = readOrchestrationSpanMetaSync(instanceId, traceContext)

  if (!meta?.traceId || !meta?.spanId) {
    meta = createOrchestrationMeta(instanceId, invocationContext, functionName)
    publishOrchestrationMetaSync(instanceId, meta)
  } else if (meta.pendingStart) {
    // Seeded at startNew time; the orchestration is only starting now.
    meta = {
      ...meta,
      functionName: meta.functionName || functionName,
      startTime: Date.now(),
      pendingStart: undefined,
    }
    publishOrchestrationMetaSync(instanceId, meta)
  }

  const httpParent = resolveHttpParentForOrchestration(instanceId, traceContext)
  if (httpParent?.spanId) {
    const updated = applyHttpParentToMeta(meta, httpParent)
    if (updated.parentId !== meta.parentId || updated.httpParentSpanId !== meta.httpParentSpanId) {
      publishOrchestrationMetaSync(instanceId, updated)
      meta = updated
    }
  }

  return meta
}

// The shared store is authoritative: it carries the orchestration parent, which
// the tracestate marker cannot express. Tracestate is only a fallback for workers
// that have no store record.
function readOrchestrationSpanMetaSync (instanceId, traceContext) {
  if (instanceId) {
    if (META_CACHE.has(instanceId)) {
      return META_CACHE.get(instanceId)
    }

    const fromFile = readMetaFileSync(instanceId)
    if (fromFile?.traceId && fromFile.spanId) {
      META_CACHE.set(instanceId, fromFile)
      return fromFile
    }
  }

  const fromTraceState = parseOrchestrationMetaFromTraceContext(traceContext)
  if (fromTraceState?.traceId && fromTraceState.spanId) {
    return fromTraceState
  }
}

async function readOrchestrationSpanMetaAsync (instanceId, traceContext) {
  const cached = readOrchestrationSpanMetaSync(instanceId, traceContext)
  if (cached) return cached

  const client = getTableClient()
  if (!client || !instanceId) return

  // Attempts are sequential by nature: each one only runs after the previous
  // read failed, and the backoff grows between them.
  /* eslint-disable no-await-in-loop */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await ensureTable()
      const entity = await client.getEntity(TABLE_PARTITION_KEY, instanceId)
      const meta = {
        traceId: entity.traceId,
        spanId: entity.spanId,
        parentId: entity.parentId || undefined,
        httpParentSpanId: entity.httpParentSpanId || undefined,
        functionName: entity.functionName || undefined,
        pendingStart: entity.pendingStart === true ? true : undefined,
        startTime: entity.startTime,
        status: entity.status,
      }
      if (meta.traceId && meta.spanId) {
        META_CACHE.set(instanceId, meta)
        writeMetaFileSync(instanceId, meta)
        return meta
      }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
  /* eslint-enable no-await-in-loop */
}

function markOrchestrationMetaCompleted (instanceId) {
  const meta = readOrchestrationSpanMetaSync(instanceId)
  if (!meta || meta.status === 'completed') return false

  const completedMeta = { ...meta, status: 'completed' }
  publishOrchestrationMetaSync(instanceId, completedMeta)
  return true
}

function clearOrchestrationSpanMeta (instanceId) {
  if (!instanceId) return
  META_CACHE.delete(instanceId)
  deleteMetaFileSync(instanceId)
}

function completeOrchestrationSpan (tracerName, instanceId, invocationContext, functionName, error) {
  let meta = readOrchestrationSpanMetaSync(instanceId, invocationContext?.traceContext)
  if (!meta || meta.status === 'completed') return false

  const httpParent = resolveHttpParentForOrchestration(instanceId, invocationContext?.traceContext)
  if (httpParent?.spanId) {
    meta = applyHttpParentToMeta(meta, httpParent)
    publishOrchestrationMetaSync(instanceId, meta)
  }

  if (!markOrchestrationMetaCompleted(instanceId)) return false

  const exported = exportOrchestrationSpanFromMeta(
    tracerName,
    { ...meta, functionName: meta.functionName || functionName },
    { error, endTime: Date.now() },
  )

  clearOrchestrationSpanMeta(instanceId)
  return exported
}

function injectOrchestrationMetaIntoTraceState (traceContext, meta) {
  if (!traceContext || !meta?.spanId) return traceContext

  return {
    ...traceContext,
    traceState: appendOrchestrationSpanToTraceState(traceContext.traceState, meta.spanId),
  }
}

module.exports = {
  clearOrchestrationSpanMeta,
  completeOrchestrationSpan,
  ensureOrchestrationMeta,
  injectOrchestrationMetaIntoTraceState,
  publishOrchestrationMetaSync,
  publishOrchestrationSpanMetaSync,
  readOrchestrationSpanMetaAsync,
  readOrchestrationSpanMetaSync,
  reconcileOrchestrationHttpParent,
  seedOrchestrationMetaFromHttpParent,
}
