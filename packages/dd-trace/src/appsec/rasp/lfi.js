'use strict'

const { fsOperationStart } = require('../channels')
const { storage } = require('../../../../datadog-core')
const { enable: enableFsPlugin, disable: disableFsPlugin } = require('./fs-plugin')
const { FS_OPERATION_PATH } = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')
const { isAbsolute } = require('path')

let config

function enable (_config) {
  config = _config

  enableFsPlugin('rasp')

  fsOperationStart.subscribe(analyzeLfi)
}

function disable () {
  if (fsOperationStart.hasSubscribers) fsOperationStart.unsubscribe(analyzeLfi)

  disableFsPlugin('rasp')
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
  const pathArguments = [
    ctx.dest,
    ctx.existingPath,
    ctx.file,
    ctx.newPath,
    ctx.oldPath,
    ctx.path,
    ctx.prefix,
    ctx.src
  ]

  return pathArguments.filter(path => shouldAnalyze(path, fs))
}

function shouldAnalyze (path, fs) {
  if (!path) return

  const notExcludedRootOp = !fs.opExcluded && fs.root
  return notExcludedRootOp && (isAbsolute(path) || path.includes('../'))
}

module.exports = {
  enable,
  disable
}
