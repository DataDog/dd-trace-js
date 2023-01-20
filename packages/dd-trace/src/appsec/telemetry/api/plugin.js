'use strict'

const dc = require('../../../../../diagnostics_channel')
const log = require('../../../log')
const { sendData } = require('../../../telemetry/send-data')

const telemetryStartChannel = dc.channel('datadog:telemetry:start')
const telemetryStopChannel = dc.channel('datadog:telemetry:stop')

module.exports = class TelemetryPlugin {
  constructor (reqType) {
    this.reqType = reqType
    this.initialized = false
    this.providers = new Set()

    this._onTelemetryStart = (msg) => {
      if (!msg) {
        log.info(`IAST telemetry ${this.reqType} start received but configuration is incorrect`)
        return false
      }
      this.start(msg.config, msg.application, msg.host, msg.heartbeatInterval)
    }
    this._onTelemetryStop = () => {
      this.stop()
    }
  }

  init (config, onStartCallback) {
    if (!this.initialized) {
      telemetryStartChannel.subscribe(this._onTelemetryStart)
      telemetryStopChannel.subscribe(this._onTelemetryStop)
      this.initialized = true
      this.onStartCallback = onStartCallback
    }
    return this.initialized
  }

  start (aConfig, appplicationObject, hostObject, heartbeatInterval) {
    this.config = aConfig
    this.application = appplicationObject
    this.host = hostObject
    this.heartbeatInterval = this.heartbeatInterval || heartbeatInterval

    if (this.onStart(this.config) && this.heartbeatInterval) {
      if (this.onStartCallback) {
        this.onStartCallback(this.config.telemetry)
      }
      this.startInterval()
    }
  }

  startInterval () {
    if (this.interval || !this.heartbeatInterval) return

    this.interval = setInterval(() => { this.onSendData() }, this.heartbeatInterval)
    this.interval.unref()
  }

  stopInterval () {
    if (this.interval) {
      clearInterval(this.interval)
    }
  }

  registerProvider (provider) {
    if (provider) {
      this.providers.add(provider)
    }
    return this
  }

  unregisterProvider (provider) {
    if (this.providers.has(provider)) {
      this.providers.delete(provider)
    }
    if (this.providers.size === 0) {
      this.stopInterval()
    }
    return this
  }

  onSendData () {
    try {
      const payload = this.getPayload()
      if (payload) {
        this.send(payload)
      }
    } catch (e) {
      log.error(e)
    }
  }

  send (payload) {
    sendData(this.config, this.application, this.host, this.reqType, payload)
  }

  onStart () { return true }

  onStop () {
    // drain providers
    this.providers.forEach(provider => provider())
  }

  getPayload () { /* empty implementation */ }

  stop () {
    this.onStop()

    this.config = null
    this.application = null
    this.host = null
    this.providers && this.providers.clear()

    this.stopInterval()

    if (telemetryStartChannel && telemetryStartChannel.hasSubscribers) {
      telemetryStartChannel.unsubscribe(this._onTelemetryStart)
    }

    if (telemetryStopChannel && telemetryStopChannel.hasSubscribers) {
      telemetryStopChannel.unsubscribe(this._onTelemetryStop)
    }
  }
}
