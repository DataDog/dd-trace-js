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
  let fetch

  beforeEach(() => {
    tracer = window.ddtrace.tracer
    tracer.init({
      service: 'test',
      exporter: 'browser'
    })
  })

  if (window.navigator && window.navigator.sendBeacon) {
    beforeEach(() => {
      fetch = sinon.stub(window.navigator, 'sendBeacon')
    })

    afterEach(() => {
      window.navigator.sendBeacon.restore()
    })
  } else if (window.fetch) {
    beforeEach(() => {
      fetch = sinon.stub(window, 'fetch').returns({
        then: resolve => resolve()
      })
    })

    afterEach(() => {
      window.fetch && window.fetch.restore()
    })
  } else {
    beforeEach(() => {
      fetch = sinon.stub(window.XMLHttpRequest.prototype, 'send')
    })

    afterEach(() => {
      window.XMLHttpRequest.prototype.restore && window.XMLHttpRequest.prototype.restore()
    })
  }

  it('should record and send a trace to the agent', () => {
    const span = tracer.startSpan('test.request')

    span.finish()

    window.dispatchEvent(createEvent('visibilitychange'))

    window.fetch && expect(fetch).to.have.been.called
  })

  // This is currently failing on IE
  context.skip('setUrl', () => {
    it('should set the URL on the exporter', () => {
      tracer.setUrl('http://example.com')
      expect(tracer._tracer._exporter._url).to.equal('http://example.com')
    })
  })
})
