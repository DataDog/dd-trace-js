'use strict'

const { channel } = require('dc-polyfill')
const { Encoder } = require('./encoder')

const segmentStartChannel = channel('datadog:tracing:segment:start')
const segmentDiscardChannel = channel('datadog:tracing:segment:discard')
const spanStartChannel = channel('datadog:tracing:span:start')
const spanFinishChannel = channel('datadog:tracing:span:finish')
const tagsChannel = channel('datadog:tracing:span:tags')
const errorChannel = channel('datadog:tracing:span:error')

class CollectorExporter {
  constructor (config) {
    const encoder = this._encoder = new Encoder(config)

    this._handlers = new Map([
      [segmentStartChannel, encoder.encodeSegmentStart.bind(encoder)],
      [segmentDiscardChannel, encoder.encodeSegmentDiscard.bind(encoder)],
      [spanStartChannel, encoder.encodeSpanStart.bind(encoder)],
      [spanFinishChannel, encoder.encodeSpanFinish.bind(encoder)],
      [tagsChannel, encoder.encodeAddTags.bind(encoder)],
      [errorChannel, encoder.encodeException.bind(encoder)]
    ])
  }

  start () {
    this._handlers.forEach((cb, ch) => ch.subscribe(cb))
  }

  stop () {
    this._handlers.forEach((cb, ch) => ch.unsubscribe(cb))
  }

  setUrl (url) {
    this._encoder.setUrl(url)
  }
}

module.exports = { CollectorExporter }
