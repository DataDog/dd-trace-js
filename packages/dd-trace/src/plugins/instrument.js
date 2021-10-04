'use strict'

const dc = require('diagnostics_channel')
const path = require('path')
const semver = require('semver')
const { AsyncResource } = require('async_hooks')
const iitm = require('../iitm')
const ritm = require('../ritm')
const requirePackageJson = require('../require-package-json')

const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')

const channelMap = {}

function channel (name) {
  const maybe = channelMap[name]
  if (maybe) return maybe
  const ch = dc.channel(name)
  channelMap[name] = ch
  return ch
}

// TODO use shimmer?
exports.wrap = function wrap (prefix, fn) {
  const startCh = channel(prefix + ':start')
  const endCh = channel(prefix + ':end')
  const asyncEndCh = channel(prefix + ':async-end')
  const errorCh = channel(prefix + ':error')

  return function () {
    const context = { wrapped: fn }
    const cb = AsyncResource.bind(arguments[arguments.length - 1])

    startCh.publish({ context, args: arguments, thisObj: this })

    if (typeof cb === 'function') {
      arguments[arguments.length - 1] = function (error, ...result) {
        if (error) {
          errorCh.publish({ context, error, type: 'callback' })
        } else {
          if (result.length === 1) {
            result = result[0]
          }
          asyncEndCh.publish({ context, result, type: 'callback' })
        }
        cb.call(this, error, ...result)
      }
    }

    let result
    try {
      result = fn.apply(this, arguments)

      if (result && typeof result.then === 'function') {
        result.then(
          result => asyncEndCh.publish({ context, result, type: 'promise' }),
          error => errorCh.publish({ context, error, type: 'reject' })
        )
      }
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorCh.publish({ context, error, type: 'throw' })

      throw error
    } finally {
      endCh.publish({ context, result })
    }
  }
}

exports.addHook = function addHook ({ name, versions, file }, hook) {
  file = filename(name, file)
  const loaderHook = (moduleExports, moduleName, moduleBaseDir) => {
    moduleName = moduleName.replace(pathSepExpr, '/')
    const moduleVersion = getVersion(moduleBaseDir)
    if (moduleName !== file || !matchVersion(moduleVersion, versions)) {
      return
    }
    return hook(moduleExports)
  }
  ritm([name], loaderHook)
  iitm([name], loaderHook)
}

function matchVersion (version, ranges) {
  return !version || (ranges && ranges.some(range => semver.satisfies(semver.coerce(version), range)))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, module).version
  }
}

function filename (name, file) {
  return [name, file].filter(val => val).join('/')
}
