'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const prepareManifest = require('../../packages/dd-trace/src/config/prepare-core-manifest')
const { request } = require('../../packages/dd-trace/src/config/startup')
const { DD_MAJOR } = require('../../version')

const directory = resolve(__dirname, '../../packages/dd-trace/src/config')
const source = JSON.parse(readFileSync(resolve(directory, 'supported-configurations.json'), 'utf8'))
const { manifest, hostTransforms } = prepareManifest(source, DD_MAJOR)

const manifestPath = resolve(directory, 'supported-configurations.prepared.json')
writeFileSync(manifestPath, JSON.stringify(manifest))
writeFileSync(resolve(directory, 'core-config-transforms.json'), JSON.stringify({
  major: DD_MAJOR,
  bindings: hostTransforms,
  defaults: compileDefaults(manifestPath, hostTransforms),
}))

/**
 * @param {string} path
 * @param {object[]} bindings
 */
function compileDefaults (path, bindings) {
  let extras
  try {
    extras = require('@datadog/libdatadog-extras')
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') {
      throw error
    }
    return
  }
  const native = extras.maybeLoad('config_core')
  if (native === undefined) {
    return
  }
  const resolver = new native.JsConfigResolver()
  let snapshot = request(resolver, {
    operation: 'initialize',
    manifest: { kind: 'path', value: path },
    policy: { numbers: 'ecma_script' },
    host_transforms: bindings,
  })
  const hostDefaults = new Set()
  if (snapshot.status === 'pending') {
    const outcomes = snapshot.requests.map(({ key }) => {
      hostDefaults.add(key)
      return { status: 'reject' }
    })
    snapshot = request(resolver, { operation: 'resume', outcomes })
  }
  if (snapshot.status !== 'complete') {
    throw new Error('Unfinished startup default resolution')
  }
  for (const { name } of snapshot.diagnostics) {
    hostDefaults.add(name)
  }
  const defaults = Object.create(null)
  for (const { name, resolved } of snapshot.settings) {
    if (!hostDefaults.has(name)) {
      const value = resolved?.value
      defaults[name] = value?.kind === 'number' && Object.is(value.value, -0)
        ? { kind: 'number', value: '-0' }
        : value ?? null
    }
  }
  return defaults
}
