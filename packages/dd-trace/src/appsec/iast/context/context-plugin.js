'use strict'

const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../iast-context')
const overheadController = require('../overhead-controller')
const { IastPlugin } = require('../iast-plugin')
const { IAST_ENABLED_TAG_KEY } = require('../tags')
const { createTransaction, removeTransaction } = require('../taint-tracking/operations')
const vulnerabilityReporter = require('../vulnerability-reporter')
const { TagKey } = require('../telemetry/iast-metric')

class IastContextPlugin extends IastPlugin {
  startCtxOn (channelName, tag) {
    super.addSub(channelName, (message) => this.startContext())

    this._getAndRegisterSubscription({
      channelName,
      tag,
      tagKey: TagKey.SOURCE_TYPE
    })
  }

  finishCtxOn (channelName) {
    super.addSub(channelName, (message) => this.finishContext())
  }

  getRootSpan (store, topContext) {
    return store?.span
  }

  getTopContext (data) {
    return {}
  }

  newIastContext (rootSpan, data) {
    return { rootSpan }
  }

  canCreateContext (data) {
    return true
  }

  addIastEnabledTag (isRequestAcquired, rootSpan) {
    if (rootSpan?.addTags) {
      rootSpan.addTags({
        [IAST_ENABLED_TAG_KEY]: isRequestAcquired ? 1 : 0
      })
    }
  }

  startContext (data) {
    let isRequestAcquired = false
    let iastContext
    let store

    if (this.canCreateContext(data)) {
      store = storage.getStore()
      if (store) {
        const topContext = this.getTopContext(data)
        if (topContext) {
          const rootSpan = this.getRootSpan(store, topContext)

          isRequestAcquired = overheadController.acquireRequest(rootSpan)
          if (isRequestAcquired) {
            iastContext = iastContextFunctions.saveIastContext(store, topContext, this.newIastContext(rootSpan, data))
            createTransaction(rootSpan.context().toSpanId(), iastContext)
            overheadController.initializeRequestContext(iastContext)
          }
          this.addIastEnabledTag(isRequestAcquired, rootSpan)
        }
      }
    }

    return {
      isRequestAcquired,
      iastContext,
      store
    }
  }

  finishContext (data) {
    const store = storage.getStore()
    if (store) {
      const topContext = this.getTopContext(data)
      const iastContext = iastContextFunctions.getIastContext(store, topContext)
      const rootSpan = iastContext?.rootSpan
      if (iastContext && rootSpan) {
        vulnerabilityReporter.sendVulnerabilities(iastContext.vulnerabilities, rootSpan)
        removeTransaction(iastContext)
      }

      if (iastContextFunctions.cleanIastContext(store, topContext, iastContext)) {
        overheadController.releaseRequest()
      }
    }
  }
}

module.exports = IastContextPlugin
