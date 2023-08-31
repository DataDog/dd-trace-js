'use strict'

const { channel } = require('../../../diagnostics_channel')
const { Encoder } = require('./encoder')

const startChannel = channel('datadog:tracing:span:start')
const finishChannel = channel('datadog:tracing:span:finish')
const tagsChannel = channel('datadog:tracing:span:tags')
const errorChannel = channel('datadog:tracing:span:error')

class CollectorExporter {
  constructor (config) {
    this._encoder = new Encoder(config)

    this._onSpanStart = event => this._encoder.encodeSpanStart(event)
    this._onSpanFinish = event => this._encoder.encodeSpanFinish(event)
    this._onSpanTags = event => this._encoder.encodeSpanTags(event)
    this._onSpanError = event => this._encoder.encodeSpanError(event)
  }

  start () {
    startChannel.subscribe(this._onSpanStart)
    tagsChannel.subscribe(this._onSpanTags)
    errorChannel.subscribe(this._onSpanError)
    finishChannel.subscribe(this._onSpanFinish)
  }

  stop () {
    startChannel.unsubscribe(this._onSpanStart)
    tagsChannel.unsubscribe(this._onSpanTags)
    errorChannel.unsubscribe(this._onSpanError)
    finishChannel.unsubscribe(this._onSpanFinish)
  }

  setUrl (url) {
    this._encoder.setUrl(url)
  }
}

module.exports = { CollectorExporter }
