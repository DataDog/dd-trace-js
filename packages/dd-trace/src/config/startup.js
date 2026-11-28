'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * @typedef {'env_var' | 'local_stable_config' | 'fleet_stable_config' | 'code'} StartOrigin
 * @typedef {StartOrigin | 'default'} CoreOrigin
 * @typedef {{ name: string, value: string | WireValue }} StartEntry
 * @typedef {{ origin: StartOrigin, entries: StartEntry[] }} StartLayer
 * @typedef {{ kind: 'boolean', value: boolean } | { kind: 'number', value: number | 'Infinity' | '-Infinity' | '-0' }
 * | { kind: 'string' | 'json', value: string } | { kind: 'host', value: number }
 * | { kind: 'array', value: WireValue[] } | { kind: 'map', value: Record<string, string> }} WireValue
 * @typedef {{ name: string, input_name?: string, origin: CoreOrigin, input: string | WireValue, parsed?: WireValue,
 *   value: WireValue | null }} SourceEvent
 * @typedef {{ kind: 'invalid_value' | 'disallowed_value' | 'transform_rejected' | 'unknown_option' }
 * | { kind: 'transform_warning', message: string }} DiagnosticProblem
 * @typedef {{
 *   name: string,
 *   input_name?: string,
 *   origin: CoreOrigin,
 *   problem: DiagnosticProblem,
 * }} Diagnostic
 * @typedef {{ name: string, property: string, resolved: { origin: CoreOrigin, value: WireValue } | null }} Setting
 * @typedef {{ status: 'complete', settings: Setting[], diagnostics: Diagnostic[], sources: SourceEvent[] }} Snapshot
 * @typedef {{ status: 'pending', requests: { slot: number, key: string, origin: CoreOrigin, value: WireValue }[] }}
 *   Pending
 * @typedef {{ status: 'error', message: string }} Failure
 * @typedef {{
 *   request: (request: Buffer) => Buffer,
 * }} NativeResolver
 * @typedef {{
 *   major: number,
 *   bindings: object[],
 *   codeRules?: Record<string, import('./prepare-core-manifest').CodeRule>,
 *   defaults?: Record<string, WireValue | null>,
 * }} CoreManifestMetadata
 * @typedef {{ config?: CoreManifestMetadata, failure?: Error }} CoreArtifacts
 */

/** @type {CoreArtifacts | undefined} */
let artifacts

function loadCoreArtifacts () {
  try {
    /** @type {CoreManifestMetadata} */
    const config = JSON.parse(readFileSync(join(__dirname, 'core-config-transforms.json'), 'utf8'))
    return { config }
  } catch (error) {
    return error.code === 'ENOENT' ? {} : { failure: error }
  }
}

/**
 * @param {number} major
 * @returns {CoreArtifacts}
 */
function getCoreArtifacts (major) {
  artifacts ??= loadCoreArtifacts()
  return artifacts.config?.major === major ? artifacts : { failure: artifacts.failure }
}

/**
 * @param {WireValue | null | undefined} encoded
 * @param {unknown[]} [hostValues]
 * @returns {unknown}
 */
function decodeValue (encoded, hostValues) {
  switch (encoded?.kind) {
    case 'number':
      return Number(encoded.value)
    case 'json':
      return JSON.parse(encoded.value)
    case 'array':
      return encoded.value.map(item => decodeValue(item, hostValues))
    case 'host':
      return hostValues?.[encoded.value]
    default:
      return encoded?.value
  }
}

/**
 * @param {NativeResolver} resolver
 * @param {object} body
 * @returns {Snapshot | Pending}
 */
function request (resolver, body) {
  /** @type {Snapshot | Pending | Failure} */
  const reply = JSON.parse(resolver.request(Buffer.from(JSON.stringify({ version: 1, ...body }))).toString())
  if (reply.status === 'error') {
    throw new Error(reply.message)
  }
  return reply
}

/**
 * @param {StartLayer[]} layers
 * @param {number} major
 * @param {((name: string, value: unknown, origin: CoreOrigin) => unknown) | undefined} transform
 * @param {Pick<typeof import('../log'), 'debug'>} log
 * @param {Record<string, import('./prepare-core-manifest').PreparedDefinition[]>} [codeRules]
 */
function resolveStartup (layers, major, transform, log, codeRules) {
  const { config, failure } = getCoreArtifacts(major)
  if (failure) {
    log.debug('Cannot load the prepared configuration manifest: %s', failure.message)
  }
  if (!config || layers.every(({ entries }) => entries.length === 0)) {
    return
  }

  let resolver
  let reply
  try {
    const extras = require('@datadog/libdatadog-extras')
    const binding = extras.maybeLoad('config_core')
    if (binding === undefined) {
      return
    }
    resolver = new binding.JsConfigResolver()
    reply = request(resolver, {
      operation: 'resolve_once',
      manifest: codeRules === undefined
        ? { kind: 'path', value: join(__dirname, 'supported-configurations.prepared.json') }
        : { kind: 'json', value: JSON.stringify({ version: '2', supportedConfigurations: codeRules }) },
      policy: { numbers: 'ecma_script', coerce_code: codeRules !== undefined },
      host_transforms: codeRules === undefined ? config.bindings : undefined,
      inputs: { layers, skip_defaults: true, report_sources: true },
    })
  } catch (error) {
    log.debug('Cannot use the native configuration resolver: %s', error.message)
    return
  }

  /** @type {unknown[]} */
  const hostValues = []
  if (reply.status === 'pending') {
    if (transform === undefined) {
      return
    }
    const outcomes = reply.requests.map(({ key, origin, value }) => {
      const transformed = transform(key, decodeValue(value, hostValues), origin)
      return transformed === undefined
        ? { status: 'reject' }
        : { status: 'accept', value: { kind: 'host', value: hostValues.push(transformed) - 1 } }
    })
    try {
      reply = /** @type {Snapshot} */ (request(resolver, { operation: 'resume', outcomes }))
    } catch (error) {
      log.debug('Cannot finish native configuration resolution: %s', error.message)
      return
    }
  }
  return { ...reply, hostValues }
}

module.exports = { decodeValue, getCoreArtifacts, request, resolveStartup }
