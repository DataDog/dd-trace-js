import regexpEscape from 'escape-string-regexp'
import * as iitm from 'import-in-the-middle/hook.mjs'
import hooks from './packages/datadog-instrumentations/src/helpers/hooks.js'
import configHelper from './packages/dd-trace/src/config-helper.js'
import path from 'path'

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

function addInstrumentations (data) {
  const instrumentations = Object.keys(hooks)

  for (const moduleName of instrumentations) {
    if (isFilePath(moduleName)) {
      // Convert file paths to file URLs for iitm
      try {
        const absolutePath = path.resolve(moduleName)
        const fileUrl = `file://${absolutePath}`
        data.include.push(fileUrl)
        process._rawDebug(`Added file URL "${fileUrl}" to iitm include list`)
      } catch (e) {
        console.warn(`Failed to resolve file path "${moduleName}": ${e.message}`)
      }
    } else {
      data.include.push(new RegExp(`node_modules/${moduleName}/(?!node_modules).+`), moduleName)
    }
  }
}

function isFilePath (moduleName) {
  // Check if it's a relative or absolute file path
  // Must start with ./, ../, or /, or be a path that doesn't look like a package name
  if (moduleName.startsWith('./') || moduleName.startsWith('../') || moduleName.startsWith('/')) {
    return true
  }

  // If it contains a slash and doesn't contain node_modules, and doesn't start with @, it's likely a file path
  if (moduleName.includes('/') && !moduleName.includes('node_modules/') && !moduleName.startsWith('@')) {
    return true
  }

  return false
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

export { initialize }
export { load, getFormat, resolve, getSource } from 'import-in-the-middle/hook.mjs'
