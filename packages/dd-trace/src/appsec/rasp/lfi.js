'use strict'

const { fsOperationStart } = require('../channels')
const { storage } = require('../../../../datadog-core')
const web = require('../../plugins/util/web')
const { enable: enableFsPlugin, disable: disableFsPlugin } = require('./fs-plugin')
const { FS_OPERATION_PATH } = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')
const { block } = require('../blocking')
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
  const path = ctx?.path
  if (!path) return

  const store = storage.getStore()
  if (!store) return

  const { req, fs, res } = store
  if (!req || !fs) return

  if (shouldAnalyze(fs, path)) {
    const persistent = {
      [FS_OPERATION_PATH]: path
    }

    const result = waf.run({ persistent }, req, RULE_TYPES.LFI)

    if (result) {
      const abortController = new AbortController()
      handleResult(result, req, res, abortController, config)

      const { aborted, reason } = abortController.signal
      if (aborted) {
        block(req, res, web.root(req), null, reason?.blockingAction)
      }
    }
  }
}

function shouldAnalyze (fs, path) {
  const notExcludedRootOp = !fs.opExcluded && fs.root
  return notExcludedRootOp && (isAbsolute(path) || path.includes('../'))
}

module.exports = {
  enable,
  disable
}
