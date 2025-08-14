'use strict'

const proxyquire = require('proxyquire')

describe('blocking', () => {
  const defaultBlockedTemplate = {
    html: 'block test',
    json: '{ "block": true }'
  }

  const config = {
    appsec: {
      blockedTemplateHtml: 'htmlBodyéé',
      blockedTemplateJson: 'jsonBody'
    }
  }

  let log, telemetry
  let block, delegateBlock, blockDelegate, setTemplates
  let req, res, rootSpan

  beforeEach(() => {
    log = {
      warn: sinon.stub()
    }

    telemetry = {
      updateBlockFailureMetric: sinon.stub()
    }

    const blocking = proxyquire('../../src/appsec/blocking', {
      '../log': log,
      './blocked_templates': defaultBlockedTemplate,
      './telemetry': telemetry
    })

    block = blocking.block
    delegateBlock = blocking.delegateBlock
    blockDelegate = blocking.blockDelegate
    setTemplates = blocking.setTemplates

    req = {
      headers: {}
    }

    res = {
      setHeader: sinon.stub(),
      writeHead: sinon.stub(),
      getHeaderNames: sinon.stub().returns([]),
      removeHeader: sinon.stub(),
      constructor: {
        prototype: {
          end: sinon.stub()
        }
      }
    }

    rootSpan = {
      setTag: sinon.stub()
    }
  })

  describe('block', () => {
    beforeEach(() => {
      setTemplates(config)
    })

    it('should log warn and not send blocking response when headers have already been sent', () => {
      res.headersSent = true
      const blocked = block(req, res, rootSpan)

      expect(blocked).to.be.false
      expect(log.warn).to.have.been
        .calledOnceWithExactly('[ASM] Cannot send blocking response when headers have already been sent')
      expect(rootSpan.setTag).to.have.been.calledOnceWithExactly('_dd.appsec.block.failed', 1)
      expect(res.setHeader).to.not.have.been.called
      expect(res.constructor.prototype.end).to.not.have.been.called
      expect(telemetry.updateBlockFailureMetric).to.be.calledOnceWithExactly(req)
    })

    it('should send blocking response with html type if present in the headers', () => {
      req.headers.accept = 'text/html'
      const blocked = block(req, res, rootSpan)

      expect(blocked).to.be.true
      expect(rootSpan.setTag).to.have.been.calledOnceWithExactly('appsec.blocked', 'true')
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': 12
      })
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly('htmlBodyéé')
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called
    })

    it('should send blocking response with json type if present in the headers in priority', () => {
      req.headers.accept = 'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8, application/json'
      const blocked = block(req, res, rootSpan)

      expect(blocked).to.be.true
      expect(rootSpan.setTag).to.have.been.calledOnceWithExactly('appsec.blocked', 'true')
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly('jsonBody')
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called
    })

    it('should send blocking response with json type if neither html or json is present in the headers', () => {
      const blocked = block(req, res, rootSpan)

      expect(blocked).to.be.true
      expect(rootSpan.setTag).to.have.been.calledOnceWithExactly('appsec.blocked', 'true')
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly('jsonBody')
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called
    })

    it('should send blocking response and call abortController if passed in arguments', () => {
      const abortController = new AbortController()
      const blocked = block(req, res, rootSpan, abortController)

      expect(blocked).to.be.true
      expect(rootSpan.setTag).to.have.been.calledOnceWithExactly('appsec.blocked', 'true')
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly('jsonBody')
      expect(abortController.signal.aborted).to.be.true
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called
    })

    it('should remove all headers before sending blocking response', () => {
      res.getHeaderNames.returns(['header1', 'header2'])

      const blocked = block(req, res, rootSpan)

      expect(blocked).to.be.true
      expect(rootSpan.setTag).to.have.been.calledOnceWithExactly('appsec.blocked', 'true')
      expect(res.removeHeader).to.have.been.calledTwice
      expect(res.removeHeader.firstCall).to.have.been.calledWithExactly('header1')
      expect(res.removeHeader.secondCall).to.have.been.calledWithExactly('header2')
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly('jsonBody')
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called
    })
  })

  describe('block delegation', () => {
    it('should delegate block', (done) => {
      setTemplates(config)

      const abortController = new AbortController()
      const promise = delegateBlock(req, res, rootSpan, abortController)

      expect(rootSpan.setTag).to.not.have.been.called
      expect(res.writeHead).to.not.have.been.called
      expect(res.constructor.prototype.end).to.not.have.been.called
      expect(abortController.signal.aborted).to.be.false
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called

      const blocked = blockDelegate(res)

      expect(blocked).to.be.true
      expect(rootSpan.setTag).to.have.been.calledOnceWithExactly('appsec.blocked', 'true')
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly('jsonBody')
      expect(abortController.signal.aborted).to.be.true
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called

      promise.then(blocked => {
        expect(blocked).to.be.true
        done()
      })
    })

    it('should only resolve the first blocking delegation per request', (done) => {
      const firstPromise = delegateBlock(req, res, rootSpan)
      const secondPromise = sinon.stub()
      const thirdPromise = sinon.stub()
      delegateBlock(req, res, rootSpan).then(secondPromise)
      delegateBlock(req, res, rootSpan).then(thirdPromise)

      const blocked = blockDelegate(res)

      expect(blocked).to.be.true
      expect(rootSpan.setTag).to.have.been.calledOnce
      expect(res.writeHead).to.have.been.calledOnce
      expect(res.constructor.prototype.end).to.have.been.calledOnce
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called

      firstPromise.then((blocked) => {
        expect(blocked).to.be.true

        setTimeout(() => {
          expect(secondPromise).to.not.have.been.called
          expect(thirdPromise).to.not.have.been.called
          done()
        }, 100)
      })
    })

    it('should do nothing if no blocking delegation exists', () => {
      const blocked = blockDelegate(res)

      expect(blocked).to.not.be.ok
      expect(log.warn).to.not.have.been.called
      expect(rootSpan.setTag).to.not.have.been.called
      expect(res.writeHead).to.not.have.been.called
      expect(res.constructor.prototype.end).to.not.have.been.called
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called
    })

    it('should cancel block delegations when block is called', (done) => {
      const promise = sinon.stub()

      delegateBlock(req, res, rootSpan).then(promise)

      const blocked = block(req, res, rootSpan)

      expect(blocked).to.be.true
      expect(rootSpan.setTag).to.have.been.calledOnce
      expect(res.writeHead).to.have.been.calledOnce
      expect(res.constructor.prototype.end).to.have.been.calledOnce
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called

      const result = blockDelegate(res)

      expect(result).to.not.be.ok
      expect(rootSpan.setTag).to.have.been.calledOnce
      expect(res.writeHead).to.have.been.calledOnce
      expect(res.constructor.prototype.end).to.have.been.calledOnce
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called

      setTimeout(() => {
        expect(promise).to.not.have.been.called
        done()
      }, 100)
    })
  })

  describe('block with default templates', () => {
    const config = {
      appsec: {
        blockedTemplateHtml: undefined,
        blockedTemplateJson: undefined
      }
    }

    it('should block with default html template', () => {
      req.headers.accept = 'text/html'
      setTemplates(config)

      const blocked = block(req, res, rootSpan)

      expect(blocked).to.be.true
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.html)
    })

    it('should block with default json template', () => {
      setTemplates(config)

      const blocked = block(req, res, rootSpan)

      expect(blocked).to.be.true
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.json)
    })
  })

  describe('block with custom actions', () => {
    const config = {
      appsec: {
        blockedTemplateHtml: undefined,
        blockedTemplateJson: undefined
      }
    }

    it('should block with default html template and custom status', () => {
      const actionParameters = {
        status_code: 401,
        type: 'auto'
      }
      req.headers.accept = 'text/html'
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      expect(blocked).to.be.true
      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.html)
    })

    it('should block with default json template and custom status ' +
      'when type is forced to json and accept is html', () => {
      const actionParameters = {
        status_code: 401,
        type: 'json'
      }
      req.headers.accept = 'text/html'
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      expect(blocked).to.be.true
      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.json)
    })

    it('should block with default html template and custom status ' +
      'when type is forced to html and accept is html', () => {
      const actionParameters = {
        status_code: 401,
        type: 'html'
      }
      req.headers.accept = 'text/html'
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      expect(blocked).to.be.true
      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.html)
    })

    it('should block with default json template and custom status', () => {
      const actionParameters = {
        status_code: 401,
        type: 'auto'
      }
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      expect(blocked).to.be.true
      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.json)
    })

    it('should block with default json template and custom status ' +
      'when type is forced to json and accept is not defined', () => {
      const actionParameters = {
        status_code: 401,
        type: 'json'
      }
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      expect(blocked).to.be.true
      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.json)
    })

    it('should block with default html template and custom status ' +
      'when type is forced to html and accept is not defined', () => {
      const actionParameters = {
        status_code: 401,
        type: 'html'
      }
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      expect(blocked).to.be.true
      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.constructor.prototype.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.html)
    })

    it('should block with custom redirect', () => {
      const actionParameters = {
        status_code: 301,
        location: '/you-have-been-blocked'
      }
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      expect(blocked).to.be.true
      expect(res.writeHead).to.have.been.calledOnceWithExactly(301, {
        Location: '/you-have-been-blocked'
      })
      expect(res.constructor.prototype.end).to.have.been.calledOnce
    })
  })
})

describe('waf actions', () => {
  const blocking = require('../../src/appsec/blocking')

  it('get block_request as blocking action', () => {
    const blockRequestActionParameters = {
      status_code: 401,
      type: 'html'
    }
    const actions = {
      block_request: blockRequestActionParameters
    }
    expect(blocking.getBlockingAction(actions)).to.be.deep.equal(blockRequestActionParameters)
  })

  it('get redirect_request as blocking action', () => {
    const redirectRequestActionParameters = {
      status_code: 301
    }

    const actions = {
      redirect_request: redirectRequestActionParameters
    }
    expect(blocking.getBlockingAction(actions)).to.be.deep.equal(redirectRequestActionParameters)
  })

  it('get undefined when no actions', () => {
    const actions = {}
    expect(blocking.getBlockingAction(actions)).to.be.undefined
  })

  it('get undefined when generate_stack action', () => {
    const actions = {
      generate_stack: {}
    }
    expect(blocking.getBlockingAction(actions)).to.be.undefined
  })
})
