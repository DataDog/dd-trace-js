import regexpEscape from 'escape-string-regexp'
import * as iitm from 'import-in-the-middle/hook.mjs'
import hooks from './packages/datadog-instrumentations/src/helpers/hooks.js'
import configHelper from './packages/dd-trace/src/config-helper.js'
import log from './packages/dd-trace/src/log/index.js'
import path from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import extractOutput from './packages/datadog-instrumentations/src/helpers/extract-prisma-client-path.js'
// For some reason `getEnvironmentVariable` is not otherwise available to ESM.
const env = configHelper.getEnvironmentVariable
const ddPrismaOutputEnv = (env('DD_PRISMA_OUTPUT') || '').trim()
// Only run extractOutput() if DD_PRISMA_OUTPUT is explicitly set to 'auto'
// If it's set to an actual path, use that path directly
// If it's not set, skip extraction entirely
const prismaOutput = ddPrismaOutputEnv === 'auto' ? extractOutput() : (ddPrismaOutputEnv || null)

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
      const absolutePath = resolveFilePath(moduleName)
      if (!absolutePath) {
        continue
      }
      try {
        const fileUrl = pathToFileURL(absolutePath).href
        // Use a RegExp to match the directory and all files inside it
        // This is similar to how node_modules packages are matched
        const escapedUrl = regexpEscape(fileUrl)
        data.include.push(new RegExp(`^${escapedUrl}(/.*)?$`))
      } catch (e) {
        log.warn('Failed to convert file path "%s" to URL: %s', absolutePath, e.message)
      }
    } else {
      data.include.push(new RegExp(`node_modules/${moduleName}/(?!node_modules).+`), moduleName)
    }
  }
}

function isFilePath (moduleName) {
  if (moduleName.startsWith('./') || moduleName.startsWith('../') || moduleName.startsWith('/')) {
    return true
  }

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

function resolveFilePath (moduleName) {
  let candidate

  if (moduleName === prismaOutput) {
    candidate = prismaOutput
  }

  // For now we only want to support path resolution for prisma
  if (!candidate) {
    return null
  }

  if (path.isAbsolute(candidate)) {
    return candidate
  }

  return path.resolve(candidate)
}
