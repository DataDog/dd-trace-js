'use strict'

const SpanLink = require('./span_link')

const MAX_SPAN_LINKS_LENGTH = 25000

class SpanLinkManager {
  constructor (spanId, links = []) {
    this._spanId = spanId
    this._links = links
      .forEach(link => new SpanLink({ ...link, spanID: spanId }))
  }

  addLink () {
    this._links.push(new SpanLink()) // update with data
  }

  // maybe also by link.name?
  getLink ({ traceID, spanID }) {
    return this._links.find(link => link.traceID === traceID && link.spanID === spanID)
  }

  format () {}

  encode () {
    let encoded = '['
    for (const link of this._links) {
      if (encoded.length + link.length >= MAX_SPAN_LINKS_LENGTH) {
        link.flushAttributes()
      }
      if (encoded.length + link.length < MAX_SPAN_LINKS_LENGTH) {
        encoded += link.encode() + ','
      }
    }
    return encoded.slice(0, -1) + ']' // remove trailing comma
  }
}

module.exports = SpanLinkManager
