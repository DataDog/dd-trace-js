import regexpEscapeModule from './vendor/dist/escape-string-regexp/index.js'
import * as iitm from 'import-in-the-middle/hook.mjs'
import hooks from './packages/datadog-instrumentations/src/helpers/hooks.js'
import configHelper from './packages/dd-trace/src/config-helper.js'
import * as rewriterLoader from './packages/datadog-instrumentations/src/helpers/rewriter/loader.mjs'

const regexpEscape = regexpEscapeModule.default

// For some reason `getEnvironmentVariable` is not otherwise available to ESM.
const env = configHelper.getEnvironmentVariable

function initialize (data = {}) {
  data.include ??= []
  data.exclude ??= []

  addInstrumentations(data)
  addSecurityControls(data)
  addExclusions(data)

  return iitm.initialize(data)
}

function load (url, context, nextLoad) {
  return rewriterLoader.load(url, context, (url, context) => iitm.load(url, context, nextLoad))
}

function addInstrumentations (data) {
  const instrumentations = Object.keys(hooks)

  for (const moduleName of instrumentations) {
    data.include.push(new RegExp(`node_modules/${moduleName}/(?!node_modules).+`), moduleName)
  }
}

function addSecurityControls (data) {
  const securityControls = (env('DD_IAST_SECURITY_CONTROLS_CONFIGURATION') || '')
    .split(';')
    .map(sc => sc.trim().split(':')[2])
    .filter(Boolean)
    .map(sc => sc.trim())

  for (const subpath of securityControls) {
    data.include.push(new RegExp(regexpEscape(subpath)))
  }
}

function addExclusions (data) {
  data.exclude.push(
    /middle/,
    /langsmith/,
    /openai\/_shims/,
    /openai\/resources\/chat\/completions\/messages/,
    /openai\/agents-core\/dist\/shims/,
    /@anthropic-ai\/sdk\/_shims/
  )
}

export { initialize, load }
export { getFormat, resolve, getSource } from 'import-in-the-middle/hook.mjs'
