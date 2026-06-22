'use strict'

// OpenTelemetry database semantic-convention attribute names, emitted in place
// of the Datadog ones when `DD_TRACE_OTEL_SEMANTICS_ENABLED` is set.
// See https://opentelemetry.io/docs/specs/semconv/db/database-spans/
const DB_SYSTEM_NAME = 'db.system.name'
const DB_NAMESPACE = 'db.namespace'
const DB_OPERATION_NAME = 'db.operation.name'
const DB_COLLECTION_NAME = 'db.collection.name'
const DB_QUERY_TEXT = 'db.query.text'
const SERVER_ADDRESS = 'server.address'
const SERVER_PORT = 'server.port'

// Datadog `db.type` values -> stable OTel `db.system.name` values. A value not
// listed here is passed through unchanged.
const DB_SYSTEM_NAME_MAP = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  mssql: 'microsoft.sql_server',
  oracle: 'oracle.db',
}

// Datadog DB meta keys that have an OTel equivalent — omitted when rebuilding
// meta so the output carries only the OTel name (mutually exclusive).
const DD_DB_META_KEYS = new Set(['db.type', 'db.name', 'db.instance', 'out.host'])
const NETWORK_DESTINATION_PORT = 'network.destination.port'

// SQL commands whose leading keyword is the operation name (db.operation.name).
const SQL_OPERATIONS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CALL', 'EXEC', 'EXECUTE',
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE',
])

/**
 * Best-effort extraction of the SQL operation from a query: the leading keyword,
 * upper-cased, when it is a recognized command. Returns undefined otherwise (the
 * spec leaves db.operation.name unset when it isn't readily available).
 *
 * @param {string} query
 * @returns {string | undefined}
 */
function parseOperationName (query) {
  const match = /^[\s(]*([a-zA-Z]+)/.exec(query)
  if (match === null) return
  const operation = match[1].toUpperCase()
  return SQL_OPERATIONS.has(operation) ? operation : undefined
}

/**
 * Best-effort extraction of the primary table (db.collection.name) for a
 * single-collection statement. Returns undefined when ambiguous — the spec sets
 * db.collection.name only when it is readily available for a single collection.
 *
 * @param {string} query
 * @param {string} operation
 * @returns {string | undefined}
 */
function parseCollectionName (query, operation) {
  let match
  switch (operation) {
    case 'INSERT': match = /\binto\s+["'`]?([\w.$]+)/i.exec(query); break
    case 'UPDATE': match = /\bupdate\s+["'`]?([\w.$]+)/i.exec(query); break
    case 'SELECT':
    case 'DELETE': match = /\bfrom\s+["'`]?([\w.$]+)/i.exec(query); break
    default: return
  }
  return match === null ? undefined : match[1].replaceAll(/["'`]/g, '')
}

/**
 * Rewrite a formatted span's Datadog database tags to OpenTelemetry database
 * semantic-convention names, in place. Called at serialization time from
 * `span_processor` when `DD_TRACE_OTEL_SEMANTICS_ENABLED` is set, so every SQL
 * integration (pg, mysql, mysql2, mariadb, tedious, ...) is covered from one
 * place. No-op for non-SQL spans (identified by the Datadog `db.type` tag). The
 * span keeps the Datadog tag names throughout its lifetime — only the serialized
 * output is renamed — so runtime consumers (peer.service, trace stats) are
 * unaffected, and the rename reaches both the agent and OTLP exporters.
 *
 * @param {{ meta: Record<string, string>, metrics: Record<string, number>, resource?: string }} formattedSpan
 */
function applyDatabaseOtelSemantics (formattedSpan) {
  const meta = formattedSpan.meta
  const metrics = formattedSpan.metrics
  const dbType = meta['db.type']
  if (dbType === undefined) return

  // Rebuild meta/metrics as fresh objects that omit the renamed Datadog keys —
  // same rationale as the HTTP helper (avoids V8 dictionary mode, can't leak a
  // renamed key as undefined on the OTLP path).
  const newMeta = {}
  for (const key of Object.keys(meta)) {
    if (!DD_DB_META_KEYS.has(key)) newMeta[key] = meta[key]
  }
  const newMetrics = {}
  for (const key of Object.keys(metrics)) {
    if (key !== NETWORK_DESTINATION_PORT) newMetrics[key] = metrics[key]
  }

  newMeta[DB_SYSTEM_NAME] = DB_SYSTEM_NAME_MAP[dbType] ?? dbType

  const dbName = meta['db.name'] ?? meta['db.instance']
  if (dbName !== undefined) newMeta[DB_NAMESPACE] = dbName

  const outHost = meta['out.host']
  if (outHost !== undefined) newMeta[SERVER_ADDRESS] = outHost

  // server.port is typed as an int by the spec, so it stays a numeric metric
  // (the OTLP exporter serializes metrics as intValue) — mirroring the HTTP helper.
  const port = metrics[NETWORK_DESTINATION_PORT]
  if (port !== undefined) newMetrics[SERVER_PORT] = port

  // The query is the span resource. db.operation.name / db.collection.name are
  // derived from it for single-statement queries.
  const query = formattedSpan.resource
  if (typeof query === 'string' && query.length > 0) {
    newMeta[DB_QUERY_TEXT] = query
    const operation = parseOperationName(query)
    if (operation !== undefined) {
      newMeta[DB_OPERATION_NAME] = operation
      const collection = parseCollectionName(query, operation)
      if (collection !== undefined) newMeta[DB_COLLECTION_NAME] = collection
    }
  }

  formattedSpan.meta = newMeta
  formattedSpan.metrics = newMetrics
}

module.exports = {
  parseOperationName, // exercised directly by the helper spec
  parseCollectionName, // exercised directly by the helper spec
  applyDatabaseOtelSemantics,
}
