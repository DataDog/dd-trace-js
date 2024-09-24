'use strict'

const { fsOperationStart, incomingHttpRequestStart } = require('../channels')
const { storage } = require('../../../../datadog-core')
const { enable: enableFsPlugin, disable: disableFsPlugin } = require('./fs-plugin')
const { FS_OPERATION_PATH } = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')
const { isAbsolute } = require('path')

let config
let enabled

function enable (_config) {
  config = _config

  if (enabled) return

  enabled = true

  incomingHttpRequestStart.subscribe(onFirstReceivedRequest)
}

function disable () {
  if (fsOperationStart.hasSubscribers) fsOperationStart.unsubscribe(analyzeLfi)
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(onFirstReceivedRequest)

  disableFsPlugin('rasp')

  enabled = false
}

function onFirstReceivedRequest () {
  process.nextTick(() => {
    // TODO: review. If unsubscribe is called synchronously other incomingHttpRequestStart listeners like
    // appsec incomingHttpStartTranslator are not called
    incomingHttpRequestStart.unsubscribe(onFirstReceivedRequest)
  })

  enableFsPlugin('rasp')

  fsOperationStart.subscribe(analyzeLfi)
}

function analyzeLfi (ctx) {
  const store = storage.getStore()
  if (!store) return

  const { req, fs, res } = store
  if (!req || !fs) return

  getPaths(ctx, fs).forEach(path => {
    const persistent = {
      [FS_OPERATION_PATH]: path
    }

    const result = waf.run({ persistent }, req, RULE_TYPES.LFI)
    handleResult(result, req, res, ctx.abortController, config)
  })
}

function getPaths (ctx, fs) {
  // these properties could have String, Buffer, URL, Integer or FileHandle types
  const pathArguments = [
    ctx.dest,
    ctx.existingPath,
    ctx.file,
    ctx.newPath,
    ctx.oldPath,
    ctx.path,
    ctx.prefix,
    ctx.src,
    ctx.target
  ]

  return pathArguments
    .map(path => pathToStr(path))
    .filter(path => shouldAnalyze(path, fs))
}

function pathToStr (path) {
  if (!path) return

  if (typeof path === 'string' ||
      path instanceof String ||
      path instanceof Buffer ||
      path instanceof URL) {
    return path.toString()
  }
}

function shouldAnalyze (path, fs) {
  if (!path) return

  const notExcludedRootOp = !fs.opExcluded && fs.root
  return notExcludedRootOp && (isAbsolute(path) || path.includes('../') || shouldAnalyzeURLFile(path, fs))
}

function shouldAnalyzeURLFile (path, fs) {
  if (path.startsWith('file://')) {
    return shouldAnalyze(path.substring(7), fs)
  }
}

module.exports = {
  enable,
  disable
}
