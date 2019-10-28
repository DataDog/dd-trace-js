'use strict'

describe('dd-trace', () => {
  let tracer

  beforeEach(() => {
    tracer = window.ddtrace.tracer

    sinon.stub(navigator, 'sendBeacon')

    tracer.init({
      service: 'test',
      exporter: 'browser'
    })
  })

  afterEach(() => {
    navigator.sendBeacon.restore()
  })

  it('should record and send a trace to the agent', () => {
    const span = tracer.startSpan('test.request')

    span.finish()

    window.dispatchEvent(new window.Event('unload'))

    expect(navigator.sendBeacon).to.have.been.called
  })
})
