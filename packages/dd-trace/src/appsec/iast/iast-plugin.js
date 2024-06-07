'use strict'

const { channel } = require('dc-polyfill')

const iastLog = require('./iast-log')
const Plugin = require('../../plugins/plugin')
const iastTelemetry = require('./telemetry')
const { getInstrumentedMetric, getExecutedMetric, TagKey, EXECUTED_SOURCE, formatTags } =
  require('./telemetry/iast-metric')
const { storage } = require('../../../../datadog-core')
const { getIastContext } = require('./iast-context')
const instrumentations = require('../../../../datadog-instrumentations/src/helpers/instrumentations')

/**
 * Used by vulnerability sources and sinks to subscribe diagnostic channel events
 * and indicate what kind of metrics the subscription provides
 * - moduleName is used identify when a module is loaded and
 *    to increment the INSTRUMENTED_[SINK|SOURCE] metric when it occurs
 * - channelName is the channel used by the hook to publish execution events
 * - tag indicates the name of the metric: taint-tracking/source-types for Sources and analyzers type for Sinks
 * - tagKey can be only SOURCE_TYPE (Source) or VULNERABILITY_TYPE (Sink)
 */
class IastPluginSubscription {
  constructor (moduleName, channelName, tagValues, tagKey = TagKey.VULNERABILITY_TYPE) {
    this.moduleName = moduleName
    this.channelName = channelName

    tagValues = Array.isArray(tagValues) ? tagValues : [tagValues]
    this.tags = formatTags(tagValues, tagKey)

    this.executedMetric = getExecutedMetric(tagKey)
    this.instrumentedMetric = getInstrumentedMetric(tagKey)

    this.moduleInstrumented = false
  }

  increaseInstrumented () {
    if (!this.moduleInstrumented) {
      this.moduleInstrumented = true

      this.tags.forEach(tag => this.instrumentedMetric.inc(undefined, tag))
    }
  }

  increaseExecuted (iastContext) {
    this.tags.forEach(tag => this.executedMetric.inc(iastContext, tag))
  }

  matchesModuleInstrumented (name) {
    // https module is a special case because it's events are published as http
    name = name === 'https' ? 'http' : name
    return this.moduleName === name
  }
}

class IastPlugin extends Plugin {
  constructor () {
    super()
    this.configured = false
    this.pluginSubs = []
  }

  _wrapHandler (handler) {
    return (message, name) => {
      try {
        handler(message, name)
      } catch (e) {
        iastLog.errorAndPublish(e)
      }
    }
  }

  _getTelemetryHandler (iastSub) {
    return () => {
      try {
        const iastContext = getIastContext(storage.getStore())
        iastSub.increaseExecuted(iastContext)
      } catch (e) {
        iastLog.errorAndPublish(e)
      }
    }
  }

  _execHandlerAndIncMetric ({ handler, metric, tags, iastContext = getIastContext(storage.getStore()) }) {
    try {
      const result = handler()
      if (iastTelemetry.isEnabled()) {
        if (Array.isArray(tags)) {
          tags.forEach(tag => metric.inc(iastContext, tag))
        } else {
          metric.inc(iastContext, tags)
        }
      }
      return result
    } catch (e) {
      iastLog.errorAndPublish(e)
    }
  }

  addSub (iastSub, handler) {
    if (typeof iastSub === 'string') {
      super.addSub(iastSub, this._wrapHandler(handler))
    } else {
      iastSub = this._getAndRegisterSubscription(iastSub)
      if (iastSub) {
        super.addSub(iastSub.channelName, this._wrapHandler(handler))

        if (iastTelemetry.isEnabled()) {
          super.addSub(iastSub.channelName, this._getTelemetryHandler(iastSub))
        }
      }
    }
  }

  enable () {
    this.configure(true)
  }

  disable () {
    this.configure(false)
  }

  onConfigure () {}

  configure (config) {
    if (typeof config !== 'object') {
      config = { enabled: config }
    }
    if (config.enabled && !this.configured) {
      this.onConfigure()
      this.configured = true
    }

    if (iastTelemetry.isEnabled()) {
      if (config.enabled) {
        this.enableTelemetry()
      } else {
        this.disableTelemetry()
      }
    }

    super.configure(config)
  }

  _getAndRegisterSubscription ({ moduleName, channelName, tag, tagKey }) {
    if (!channelName && !moduleName) return

    if (!moduleName) {
      let firstSep = channelName.indexOf(':')
      if (firstSep === -1) {
        moduleName = channelName
      } else {
        if (channelName.startsWith('tracing:')) {
          firstSep = channelName.indexOf(':', 'tracing:'.length + 1)
        }
        const lastSep = channelName.indexOf(':', firstSep + 1)
        moduleName = channelName.substring(firstSep + 1, lastSep !== -1 ? lastSep : channelName.length)
      }
    }

    const iastSub = new IastPluginSubscription(moduleName, channelName, tag, tagKey)
    this.pluginSubs.push(iastSub)
    return iastSub
  }

  enableTelemetry () {
    if (this.onInstrumentationLoadedListener) return

    this.onInstrumentationLoadedListener = ({ name }) => this._onInstrumentationLoaded(name)
    const loadChannel = channel('dd-trace:instrumentation:load')
    loadChannel.subscribe(this.onInstrumentationLoadedListener)

    // check for already instrumented modules
    for (const name in instrumentations) {
      this._onInstrumentationLoaded(name)
    }
  }

  disableTelemetry () {
    if (!this.onInstrumentationLoadedListener) return

    const loadChannel = channel('dd-trace:instrumentation:load')
    if (loadChannel.hasSubscribers) {
      loadChannel.unsubscribe(this.onInstrumentationLoadedListener)
    }
    this.onInstrumentationLoadedListener = null
  }

  _onInstrumentationLoaded (name) {
    this.pluginSubs
      .filter(sub => sub.matchesModuleInstrumented(name))
      .forEach(sub => sub.increaseInstrumented())
  }
}

class SourceIastPlugin extends IastPlugin {
  addSub (iastPluginSub, handler) {
    return super.addSub({ tagKey: TagKey.SOURCE_TYPE, ...iastPluginSub }, handler)
  }

  addInstrumentedSource (moduleName, tag) {
    this._getAndRegisterSubscription({
      moduleName,
      tag,
      tagKey: TagKey.SOURCE_TYPE
    })
  }

  execSource (sourceHandlerInfo) {
    this._execHandlerAndIncMetric({
      metric: EXECUTED_SOURCE,
      ...sourceHandlerInfo
    })
  }
}

class SinkIastPlugin extends IastPlugin {
  addSub (iastPluginSub, handler) {
    return super.addSub({ tagKey: TagKey.VULNERABILITY_TYPE, ...iastPluginSub }, handler)
  }

  addNotSinkSub (iastPluginSub, handler) {
    return super.addSub(iastPluginSub, handler)
  }
}

module.exports = {
  SourceIastPlugin,
  SinkIastPlugin,
  IastPlugin
}
