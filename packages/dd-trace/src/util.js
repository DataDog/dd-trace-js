'use strict'

const { inspect } = require('util')
const path = require('path')

const { ERROR_STACK, ERROR_MESSAGE, ERROR_TYPE, ERROR_FULL_SERIALIZED } = require('./constants')

function isTrue (str) {
  str = String(str).toLowerCase()
  return str === 'true' || str === '1'
}

function isFalse (str) {
  str = String(str).toLowerCase()
  return str === 'false' || str === '0'
}

function isError (value) {
  return Boolean(value?.message || value instanceof Error)
}

// Matches a glob pattern to a given subject string
function globMatch (pattern, subject) {
  if (typeof pattern === 'string') pattern = pattern.toLowerCase()
  if (typeof subject === 'string') subject = subject.toLowerCase()
  if (typeof subject === 'number' && Number.isInteger(subject)) subject = String(subject)

  let px = 0 // [p]attern inde[x]
  let sx = 0 // [s]ubject inde[x]
  let nextPx = 0
  let nextSx = 0
  while (px < pattern.length || sx < subject.length) {
    if (px < pattern.length) {
      const c = pattern[px]
      switch (c) {
        case '?':
          if (sx < subject.length) {
            px++
            sx++
            continue
          }
          break
        case '*':
          nextPx = px
          nextSx = sx + 1
          px++
          continue
        default: // ordinary character
          if (sx < subject.length && subject[sx] === c) {
            px++
            sx++
            continue
          }
          break
      }
    }
    if (nextSx > 0 && nextSx <= subject.length) {
      px = nextPx
      sx = nextSx
      continue
    }
    return false
  }
  return true
}

function calculateDDBasePath (dirname) {
  const dirSteps = dirname.split(path.sep)
  const packagesIndex = dirSteps.lastIndexOf('packages')
  return dirSteps.slice(0, packagesIndex).join(path.sep) + path.sep
}

function normalizeProfilingEnabledValue (configValue) {
  return isTrue(configValue)
    ? 'true'
    : isFalse(configValue)
      ? 'false'
      : configValue === 'auto' ? 'auto' : undefined
}

function normalizePluginEnvName (envPluginName, makeLowercase = false) {
  if (envPluginName.startsWith('@')) {
    envPluginName = envPluginName.slice(1)
  }
  envPluginName = envPluginName.replaceAll(/[^a-z0-9_]/ig, '_')
  return makeLowercase ? envPluginName.toLowerCase() : envPluginName
}

function addErrorProperties (object, error) {
  object[ERROR_MESSAGE] = error.message || (error.code ?? '')
  object[ERROR_TYPE] = (error.constructor ? error.constructor.name : error.name) ?? ''
  object[ERROR_STACK] = error.stack ?? ''
  object[ERROR_FULL_SERIALIZED] = inspect(error, { colors: true })
}

function addErrorTagsToSpan (span, error) {
  if (isError(error)) {
    // TODO: Do not create a new object here, just add the properties to the span
    span.addTags(addErrorProperties({}, error))
  } else {
    span.addTag(ERROR_FULL_SERIALIZED, inspect(error, { colors: true }))
  }
}

module.exports = {
  addErrorProperties,
  addErrorTagsToSpan,
  isTrue,
  isFalse,
  isError,
  globMatch,
  ddBasePath: globalThis.__DD_ESBUILD_BASEPATH || calculateDDBasePath(__dirname),
  normalizeProfilingEnabledValue,
  normalizePluginEnvName
}
