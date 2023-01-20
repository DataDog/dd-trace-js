'use strict'

const { channel } = require('../../../../diagnostics_channel')

const log = require('../../log')
const Plugin = require('../../plugins/plugin')
const telemetry = require('../telemetry')
const { getInstrumentedMetric, getExecutedMetric, MetricTag } = require('./iast-metric')
const { storage } = require('../../../../datadog-core')
const { getIastContext } = require('./iast-context')

/**
 * Used by vulnerability sources and sinks to subscribe diagnostic channel events
 * and indicate what kind of metrics the subscription provides
 * - moduleName is used identify when a module is loaded and
 *    to increment the INSTRUMENTED_[SINK|SOURCE] metric when it occurs
 * - channelName is the channel used by the hook to publish execution events
 * - tag indicates the name of the metric: taint-tracking/source-types for Sources and analyzers type for Sinks
 * - metricTag can be only SOURCE_TYPE (Source) or VULNERABILITY_TYPE (Sink)
 */
class IastPluginSubscription {
  constructor (moduleName, channelName, tag, metricTag) {
    this.moduleName = moduleName
    this.channelName = channelName
    this.tag = tag
    this.metricTag = metricTag || MetricTag.VULNERABILITY_TYPE
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
        log.error(e)
      }
    }
  }

  _getTelemetryHandler (metric, tag) {
    return () => {
      try {
        const store = storage.getStore()
        const iastContext = getIastContext(store)
        metric.increase(tag, iastContext)
      } catch (e) {
        log.error(e)
      }
    }
  }

  addSub (iastSub, handler) {
    if (typeof iastSub === 'string') {
      super.addSub(iastSub, this._wrapHandler(handler))
    } else {
      iastSub = this.getSubscription(iastSub)
      if (iastSub) {
        this.pluginSubs.push(iastSub)
        const metric = getExecutedMetric(iastSub.metricTag)
        super.addSub(iastSub.channelName, this._wrapHandler(handler))

        if (telemetry.isEnabled() && metric) {
          super.addSub(iastSub.channelName, this._getTelemetryHandler(metric, iastSub.tag))
        }
      }
    }
  }

  onConfigure () {}

  configure (config) {
    if (!this.configured) {
      this.onConfigure()

      if (telemetry.isEnabled()) {
        this.enableTelemetry()
      }
      this.configured = true
    }

    super.configure(config)
  }

  getSubscription ({ moduleName, channelName, tag, metricTag }) {
    if (!channelName) return

    if (!moduleName) {
      const firstSep = channelName.indexOf(':')
      if (firstSep === -1) {
        moduleName = channelName
      } else {
        const lastSep = channelName.indexOf(':', firstSep + 1)
        moduleName = channelName.substring(firstSep + 1, lastSep !== -1 ? lastSep : channelName.length)
      }
    }
    return new IastPluginSubscription(moduleName, channelName, tag, metricTag)
  }

  enableTelemetry () {
    this.onInstrumentationLoadedListener = ({ name }) => this.onInstrumentationLoaded(name)
    const loadChannel = channel('dd-trace:instrumentation:load')
    loadChannel.subscribe(this.onInstrumentationLoadedListener)
  }

  disableTelemetry () {
    if (this.onInstrumentationLoadedListener) {
      const loadChannel = channel('dd-trace:instrumentation:load')
      if (loadChannel.hasSubscribers) {
        loadChannel.unsubscribe(this.onInstrumentationLoadedListener)
      }
    }
  }

  onInstrumentationLoaded (name) {
    this.pluginSubs
      .filter(sub => sub.moduleName.includes(name))
      .forEach(sub => {
        const metric = getInstrumentedMetric(sub.metricTag)
        metric.increase(sub.tag)
      })
  }
}

class SourceIastPlugin extends IastPlugin {
  addSub (iastPluginSub, handler) {
    return super.addSub({ metricTag: MetricTag.SOURCE_TYPE, ...iastPluginSub }, handler)
  }
}

class SinkIastPlugin extends IastPlugin {
  addSub (iastPluginSub, handler) {
    return super.addSub({ metricTag: MetricTag.VULNERABILITY_TYPE, ...iastPluginSub }, handler)
  }
}

module.exports = {
  SourceIastPlugin,
  SinkIastPlugin,
  IastPlugin
}
