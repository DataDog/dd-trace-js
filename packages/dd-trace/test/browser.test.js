'use strict'

const createEvent = (name) => {
  if (typeof Event === 'function') {
    return new Event(name)
  } else {
    const event = document.createEvent('Event')
    event.initEvent(name, true, true)
    return event
  }
}

describe('dd-trace', () => {
  let tracer

  beforeEach(() => {
    tracer = window.ddtrace.tracer
    tracer.init({
      service: 'test',
      exporter: 'browser'
    })
  })

  afterEach(() => {
    window.fetch.restore && window.fetch.restore()
  })

  it('should record and send a trace to the agent', () => {
    sinon.stub(window, 'fetch').returns({
      then: resolve => resolve()
    })

    const span = tracer.startSpan('test.request')

    span.finish()

    window.dispatchEvent(createEvent('visibilitychange'))

    expect(window.fetch).to.have.been.called
  })
})
