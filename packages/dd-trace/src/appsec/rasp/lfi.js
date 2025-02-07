'use strict'

const { fsOperationStart, incomingHttpRequestStart } = require('../channels')
const { storage } = require('../../../../datadog-core')
const { enable: enableFsPlugin, disable: disableFsPlugin, RASP_MODULE } = require('./fs-plugin')
const { FS_OPERATION_PATH } = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')
const { isAbsolute } = require('path')

let config
let enabled
let analyzeSubscribed

function enable (_config) {
  config = _config

  if (enabled) return

  enabled = true

  incomingHttpRequestStart.subscribe(onFirstReceivedRequest)
}

function disable () {
  if (fsOperationStart.hasSubscribers) fsOperationStart.unsubscribe(analyzeLfi)
  if (incomingHttpRequestStart.hasSubscribers) incomingHttpRequestStart.unsubscribe(onFirstReceivedRequest)

  disableFsPlugin(RASP_MODULE)

  enabled = false
  analyzeSubscribed = false
}

function onFirstReceivedRequest () {
  // nodejs unsubscribe during publish bug: https://github.com/nodejs/node/pull/55116
  process.nextTick(() => {
    incomingHttpRequestStart.unsubscribe(onFirstReceivedRequest)
  })

  enableFsPlugin(RASP_MODULE)

  if (!analyzeSubscribed) {
    fsOperationStart.subscribe(analyzeLfi)
    analyzeSubscribed = true
  }
}

function analyzeLfi (ctx) {
  const store = storage('legacy').getStore()
  if (!store) return

  const { req, fs, res } = store
  if (!req || !fs) return

  getPaths(ctx, fs).forEach(path => {
    const persistent = {
      [FS_OPERATION_PATH]: path
    }

    const raspRule = { type: RULE_TYPES.LFI }

    const result = waf.run({ persistent }, req, raspRule)
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
