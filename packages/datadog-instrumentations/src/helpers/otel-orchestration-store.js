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
const TABLE_PARTITION_PREFIX = 'orch'
const META_CACHE = new Map()
const earliestChildStartByInstance = new Map()

let tableClient
let tableClientResolved = false
let tableEnsured = false

function encodeStorageKey (value) {
  return Buffer.from(String(value), 'utf8').toString('base64url')
}

function getTaskHubScope () {
  return getEnvironmentVariable('TASKHUB_NAME') ||
    getEnvironmentVariable('WEBSITE_SITE_NAME') ||
    'default'
}

function getTableKeys (instanceId) {
  return {
    partitionKey: `${TABLE_PARTITION_PREFIX}:${encodeStorageKey(getTaskHubScope())}`,
    rowKey: encodeStorageKey(instanceId),
  }
}

function getStoreDirectory () {
  // Internal override for tests and local development only, so it is deliberately
  // not a registered configuration.
  // eslint-disable-next-line eslint-rules/eslint-process-env
  return process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR ||
    path.join(os.tmpdir(), 'dd-orchestration-spans')
}

function getMetaFilePath (instanceId) {
  return path.join(getStoreDirectory(), `${encodeStorageKey(instanceId)}.json`)
}

function writeMetaFileSync (instanceId, meta) {
  try {
    const directory = getStoreDirectory()
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(getMetaFilePath(instanceId), JSON.stringify(meta))
  } catch {
    // Local cache is best-effort; tracing must not break user handlers.
  }
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
    // Bundled via dd-trace optionalDependencies so apps do not need a direct install.
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

function buildTableEntity (instanceId, normalized) {
  const keys = getTableKeys(instanceId)
  return {
    partitionKey: keys.partitionKey,
    rowKey: keys.rowKey,
    instanceId: String(instanceId),
    traceId: normalized.traceId,
    spanId: normalized.spanId,
    parentId: normalized.parentId ?? '',
    httpParentSpanId: normalized.httpParentSpanId ?? '',
    functionName: normalized.functionName ?? '',
    pendingStart: normalized.pendingStart === true,
    startTime: normalized.startTime,
    earliestChildStartTime: normalized.earliestChildStartTime,
    status: normalized.status || 'open',
  }
}

function metaFromTableEntity (entity) {
  return {
    traceId: entity.traceId,
    spanId: entity.spanId,
    parentId: entity.parentId || undefined,
    httpParentSpanId: entity.httpParentSpanId || undefined,
    functionName: entity.functionName || undefined,
    pendingStart: entity.pendingStart === true ? true : undefined,
    startTime: entity.startTime,
    earliestChildStartTime: entity.earliestChildStartTime,
    status: entity.status,
  }
}

async function upsertOrchestrationMetaToTable (instanceId, normalized) {
  const client = getTableClient()
  if (!client) return

  await ensureTable()
  await client.upsertEntity(buildTableEntity(instanceId, normalized), 'Replace')
}

async function deleteOrchestrationMetaFromTable (instanceId) {
  const client = getTableClient()
  if (!client || !instanceId) return

  const keys = getTableKeys(instanceId)
  try {
    await ensureTable()
    await client.deleteEntity(keys.partitionKey, keys.rowKey)
  } catch {}
}

function awaitPromiseSync (promise, timeoutMs = 500) {
  const { MessageChannel, receiveMessageOnPort } = require('node:worker_threads')
  const { port1, port2 } = new MessageChannel()
  let settled = false
  let result
  let error

  promise
    .then((value) => {
      result = value
      settled = true
      port2.postMessage(true)
    })
    .catch((err) => {
      error = err
      settled = true
      port2.postMessage(true)
    })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (settled) break
    receiveMessageOnPort(port1, { timeout: Math.min(50, deadline - Date.now()) })
  }

  if (error) throw error
  return result
}

function readOrchestrationSpanMetaFromSharedStoreSync (instanceId, traceContext, timeoutMs = 500) {
  const cached = readOrchestrationSpanMetaSync(instanceId, traceContext)
  if (cached || !getTableClient() || !instanceId) return cached

  return awaitPromiseSync(readOrchestrationSpanMetaAsync(instanceId, traceContext), timeoutMs)
}

async function publishOrchestrationMetaAsync (instanceId, meta) {
  const normalized = normalizeMeta(meta)
  if (!instanceId || !normalized) return

  META_CACHE.set(instanceId, normalized)
  writeMetaFileSync(instanceId, normalized)

  try {
    await upsertOrchestrationMetaToTable(instanceId, normalized)
  } catch {}
}

function publishOrchestrationMetaSync (instanceId, meta) {
  const normalized = normalizeMeta(meta)
  if (!instanceId || !normalized) return

  META_CACHE.set(instanceId, normalized)
  writeMetaFileSync(instanceId, normalized)

  upsertOrchestrationMetaToTable(instanceId, normalized).catch(() => {})
}

function publishOrchestrationSpanMetaSync (instanceId, span) {
  const meta = getSpanMeta(span)
  if (!meta) return
  publishOrchestrationMetaSync(instanceId, {
    ...meta,
    startTime: meta.startTime ?? Date.now(),
    status: 'open',
  })
}

// Record the instance start once; never move it on later turns.
function stampOrchestrationStartTime (meta, functionName) {
  if (meta.startTime != null) {
    return {
      ...meta,
      functionName: meta.functionName || functionName,
      pendingStart: undefined,
    }
  }

  return {
    ...meta,
    functionName: meta.functionName || functionName,
    startTime: Date.now(),
    pendingStart: undefined,
  }
}

function recordEarliestChildStartTime (instanceId, startTime) {
  if (!instanceId || startTime == null) return

  const key = String(instanceId)
  const current = earliestChildStartByInstance.get(key)
  if (current != null && current <= startTime) {
    return
  }

  earliestChildStartByInstance.set(key, startTime)

  const meta = readOrchestrationSpanMetaSync(instanceId)
  if (!meta?.traceId || !meta?.spanId) return

  publishOrchestrationMetaSync(instanceId, {
    ...meta,
    earliestChildStartTime: startTime,
  })
}

function peekEarliestChildStartTime (instanceId) {
  if (!instanceId) return
  return earliestChildStartByInstance.get(String(instanceId))
}

function mergeInstanceStartTime (instanceId, startTime) {
  if (!instanceId || startTime == null) return

  const meta = readOrchestrationSpanMetaSync(instanceId)
  if (!meta?.traceId || !meta?.spanId) return

  if (meta.startTime != null && meta.startTime <= startTime) return

  publishOrchestrationMetaSync(instanceId, {
    ...meta,
    startTime,
  })
}

function resolveExportStartTime (meta, instanceId, endTime) {
  let startTime = meta?.startTime

  const { peekHttpInstanceStartTime } = require('./otel-orchestration-http-link')
  const httpStart = peekHttpInstanceStartTime(instanceId)
  if (httpStart != null) {
    startTime = startTime == null ? httpStart : Math.min(startTime, httpStart)
  }

  const childStart = peekEarliestChildStartTime(instanceId) ?? meta?.earliestChildStartTime
  if (childStart != null) {
    startTime = startTime == null ? childStart : Math.min(startTime, childStart)
  }

  return startTime ?? endTime
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

function finalizeOrchestrationMeta (instanceId, invocationContext, functionName, meta) {
  let updated = stampOrchestrationStartTime(meta, functionName)
  let changed = updated.startTime !== meta.startTime || updated.pendingStart !== meta.pendingStart

  const httpParent = resolveHttpParentForOrchestration(instanceId, invocationContext?.traceContext)
  if (httpParent?.spanId) {
    const withParent = applyHttpParentToMeta(updated, httpParent)
    if (withParent.parentId !== updated.parentId || withParent.httpParentSpanId !== updated.httpParentSpanId) {
      updated = withParent
      changed = true
    }
  }

  return { meta: updated, changed }
}

// Record the orchestration span identity while the HTTP span that started the
// instance is still available, so any worker that later runs the orchestration
// reads the HTTP span as its parent.
async function seedOrchestrationMetaFromHttpParent (instanceId, httpParent, functionName, instanceStartTime) {
  if (!instanceId || !httpParent?.spanId) return

  const existing = readOrchestrationSpanMetaFromSharedStoreSync(instanceId)
  if (existing?.traceId && existing.spanId) {
    return reconcileOrchestrationHttpParent(instanceId, httpParent)
  }

  const meta = createOrchestrationMetaFromHttpParent(
    instanceId,
    httpParent,
    functionName,
    instanceStartTime,
  )
  if (!meta) return

  await publishOrchestrationMetaAsync(instanceId, meta)
  return meta
}

function ensureOrchestrationMeta (instanceId, invocationContext, functionName) {
  const traceContext = invocationContext?.traceContext
  let meta = readOrchestrationSpanMetaSync(instanceId, traceContext)

  if (!meta?.traceId || !meta?.spanId) {
    meta = readOrchestrationSpanMetaFromSharedStoreSync(instanceId, traceContext)
  }

  if (!meta?.traceId || !meta?.spanId) {
    const created = finalizeOrchestrationMeta(
      instanceId,
      invocationContext,
      functionName,
      stampOrchestrationStartTime(
        createOrchestrationMeta(instanceId, invocationContext, functionName),
        functionName,
      ),
    )
    meta = created.meta
    publishOrchestrationMetaSync(instanceId, meta)
  } else {
    const updated = finalizeOrchestrationMeta(instanceId, invocationContext, functionName, meta)
    if (updated.changed) {
      meta = updated.meta
      publishOrchestrationMetaSync(instanceId, meta)
    }
  }

  return meta
}

async function ensureOrchestrationMetaAsync (instanceId, invocationContext, functionName) {
  const traceContext = invocationContext?.traceContext
  let meta = readOrchestrationSpanMetaSync(instanceId, traceContext)

  if (!meta?.traceId || !meta?.spanId) {
    meta = await readOrchestrationSpanMetaAsync(instanceId, traceContext)
  }

  if (!meta?.traceId || !meta?.spanId) {
    const created = finalizeOrchestrationMeta(
      instanceId,
      invocationContext,
      functionName,
      stampOrchestrationStartTime(
        createOrchestrationMeta(instanceId, invocationContext, functionName),
        functionName,
      ),
    )
    meta = created.meta
    await publishOrchestrationMetaAsync(instanceId, meta)
  } else {
    const updated = finalizeOrchestrationMeta(instanceId, invocationContext, functionName, meta)
    if (updated.changed) {
      meta = updated.meta
      await publishOrchestrationMetaAsync(instanceId, meta)
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

  const keys = getTableKeys(instanceId)

  // Attempts are sequential by nature: each one only runs after the previous
  // read failed, and the backoff grows between them.
  /* eslint-disable no-await-in-loop */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await ensureTable()
      const entity = await client.getEntity(keys.partitionKey, keys.rowKey)
      const meta = metaFromTableEntity(entity)
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
  earliestChildStartByInstance.delete(String(instanceId))
  deleteMetaFileSync(instanceId)
  deleteOrchestrationMetaFromTable(instanceId).catch(() => {})

  const { clearHttpOrchestrationLinks } = require('./otel-orchestration-http-link')
  clearHttpOrchestrationLinks(instanceId)
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

  const endTime = Date.now()
  const exported = exportOrchestrationSpanFromMeta(
    tracerName,
    {
      ...meta,
      functionName: meta.functionName || functionName,
      startTime: resolveExportStartTime(meta, instanceId, endTime),
    },
    { error, endTime },
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
  ensureOrchestrationMetaAsync,
  injectOrchestrationMetaIntoTraceState,
  mergeInstanceStartTime,
  publishOrchestrationMetaAsync,
  publishOrchestrationMetaSync,
  publishOrchestrationSpanMetaSync,
  readOrchestrationSpanMetaAsync,
  readOrchestrationSpanMetaFromSharedStoreSync,
  readOrchestrationSpanMetaSync,
  reconcileOrchestrationHttpParent,
  recordEarliestChildStartTime,
  resolveExportStartTime,
  seedOrchestrationMetaFromHttpParent,
  stampOrchestrationStartTime,
}
