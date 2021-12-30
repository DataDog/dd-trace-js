'use strict'

const { Config } = require('./config')
const { zeroId } = require('./id')

class NoopTracer {
  constructor () {
    this.config = new Config()
  }
  configure () {}
  startSpan () { return span }
  inject () {}
  extract () { return null }
  process () {}
  flush () {}
}

class NoopSpan {
  constructor () {
    this.trace = trace
    this.spanId = zeroId
    this.parentId = zeroId
    this.baggage = {}
    this.start = 0
    this.tracer = tracer
    this.service = ''
    this.name = ''
    this.resource = ''
    this.error = 0
    this.meta = {}
    this.metrics = {}
    this.duration = 0
    this.type = ''
  }
  setTag () {}
  setBaggageItem () {}
  getBaggageItem () {}
  addTags () {}
  addError () {}
  sample () {}
  finish () {}
}

class NoopTrace {
  constructor () {
    this.traceId = zeroId
    this.spans = []
    this.started = 0
    this.finished = 0
    this.samplingPriority = undefined
    this.samplingMechanism = undefined
    this.meta = {}
    this.metrics = {}
    this.origin = undefined
    this.start = 0
    this.ticks = 0
  }
}

const tracer = new NoopTracer()
const trace = new NoopTrace()
const span = new NoopSpan()

module.exports = { tracer }
