'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const [BullJobCreatePlugin, BullJobCreateBulkPlugin] = require('./producer')
const [BullProcessJobPlugin, BullJobMoveToFailedPlugin] = require('./consumer')

class BullPlugin extends CompositePlugin {
  static id = 'bull'

  static plugins = {
    jobCreate: BullJobCreatePlugin,
    jobCreateBulk: BullJobCreateBulkPlugin,
    processJob: BullProcessJobPlugin,
    moveToFailed: BullJobMoveToFailedPlugin,
  }
}

module.exports = BullPlugin
