import { initialize as origInitialize, load as origLoad, resolve } from 'import-in-the-middle/hook.mjs'
import regexpEscapeModule from './vendor/dist/escape-string-regexp/index.js'
import hooks from './packages/datadog-instrumentations/src/helpers/hooks.js'
import configHelper from './packages/dd-trace/src/config/helper.js'
import * as rewriterLoader from './packages/datadog-instrumentations/src/helpers/rewriter/loader.mjs'
import { isRelativeRequire } from './packages/datadog-instrumentations/src/helpers/shared-utils.js'

// This file must support Node.js 12.0.0 syntax

const regexpEscape = regexpEscapeModule.default

// For some reason `getEnvironmentVariable` is not otherwise available to ESM.
const env = configHelper.getEnvironmentVariable

function initialize (data = {}) {
  if (data.include == null) data.include = []
  if (data.exclude == null) data.exclude = []

  addInstrumentations(data)
  addSecurityControls(data)
  addExclusions(data)

  return origInitialize(data)
}

function load (url, context, nextLoad) {
  return rewriterLoader.load(url, context, (url, context) => origLoad(url, context, nextLoad))
}

function addInstrumentations (data) {
  const instrumentations = Object.keys(hooks)

  for (const moduleName of instrumentations) {
    // Skip instrumentation hooks with relative module names
    // since there is no current business need of instrumenting imports outside of the node_modules folder
    if (!isRelativeRequire(moduleName)) {
      data.include.push(new RegExp(`node_modules/${moduleName}/(?!node_modules).+`), moduleName)
    }
  }
}

function addSecurityControls (data) {
  const raw = env('DD_IAST_SECURITY_CONTROLS_CONFIGURATION')
  if (!raw) return
  // Parse `;`-separated entries and take the 3rd `:`-separated segment.
  // Expected form (per entry): `<...>:<...>:<subpath>:<...>`
  const entries = raw.split(';')
  for (const entry of entries) {
    if (entry) {
      const first = entry.indexOf(':')
      if (first === -1) continue
      const second = entry.indexOf(':', first + 1)
      if (second === -1) continue
      const third = entry.indexOf(':', second + 1)

      const subpath = entry.slice(second + 1, third === -1 ? undefined : third).trim()
      if (subpath) {
        data.include.push(new RegExp(regexpEscape(subpath)))
      }
    }
  }
}

function addExclusions (data) {
  data.exclude.push(...iitmExclusions)
}

export const iitmExclusions = [
  /middle/,
  /langsmith/,
  /openai\/_shims/,
  /openai\/resources\/chat\/completions\/messages/,
  /openai\/agents-core\/dist\/shims/,
  /@anthropic-ai\/sdk\/_shims/,
]

export { initialize, load, resolve }
