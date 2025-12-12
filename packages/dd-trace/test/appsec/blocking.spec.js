'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

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
  let block, registerBlockDelegation, callBlockDelegation, setTemplates
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
    registerBlockDelegation = blocking.registerBlockDelegation
    callBlockDelegation = blocking.callBlockDelegation
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

      assert.strictEqual(blocked, false)
      expect(log.warn).to.have.been
        .calledOnceWithExactly('[ASM] Cannot send blocking response when headers have already been sent')
      sinon.assert.calledOnceWithExactly(rootSpan.setTag, '_dd.appsec.block.failed', 1)
      sinon.assert.notCalled(res.setHeader)
      sinon.assert.notCalled(res.constructor.prototype.end)
      expect(telemetry.updateBlockFailureMetric).to.be.calledOnceWithExactly(req)
    })

    it('should send blocking response with html type if present in the headers', () => {
      req.headers.accept = 'text/html'
      const blocked = block(req, res, rootSpan)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
      sinon.assert.calledOnceWithExactly(res.writeHead, 403, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': 12
      })
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, 'htmlBodyéé')
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)
    })

    it('should send blocking response with json type if present in the headers in priority', () => {
      req.headers.accept = 'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8, application/json'
      const blocked = block(req, res, rootSpan)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
      sinon.assert.calledOnceWithExactly(res.writeHead, 403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, 'jsonBody')
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)
    })

    it('should send blocking response with json type if neither html or json is present in the headers', () => {
      const blocked = block(req, res, rootSpan)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
      sinon.assert.calledOnceWithExactly(res.writeHead, 403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, 'jsonBody')
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)
    })

    it('should send blocking response and call abortController if passed in arguments', () => {
      const abortController = new AbortController()
      const blocked = block(req, res, rootSpan, abortController)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
      sinon.assert.calledOnceWithExactly(res.writeHead, 403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, 'jsonBody')
      assert.strictEqual(abortController.signal.aborted, true)
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)
    })

    it('should remove all headers before sending blocking response', () => {
      res.getHeaderNames.returns(['header1', 'header2'])

      const blocked = block(req, res, rootSpan)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
      sinon.assert.calledTwice(res.removeHeader)
      sinon.assert.calledWithExactly(res.removeHeader.firstCall, 'header1')
      sinon.assert.calledWithExactly(res.removeHeader.secondCall, 'header2')
      sinon.assert.calledOnceWithExactly(res.writeHead, 403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, 'jsonBody')
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)
    })
  })

  describe('block delegation', () => {
    it('should delegate block', (done) => {
      setTemplates(config)

      const abortController = new AbortController()
      const promise = registerBlockDelegation(req, res, rootSpan, abortController)

      sinon.assert.notCalled(rootSpan.setTag)
      sinon.assert.notCalled(res.writeHead)
      sinon.assert.notCalled(res.constructor.prototype.end)
      assert.strictEqual(abortController.signal.aborted, false)
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)

      const blocked = callBlockDelegation(res)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
      sinon.assert.calledOnceWithExactly(res.writeHead, 403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, 'jsonBody')
      assert.strictEqual(abortController.signal.aborted, true)
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)

      promise.then(blocked => {
        assert.strictEqual(blocked, true)
        done()
      })
    })

    it('should only resolve the first blocking delegation per request', (done) => {
      const firstPromise = registerBlockDelegation(req, res, rootSpan)
      const secondPromise = sinon.stub()
      const thirdPromise = sinon.stub()
      registerBlockDelegation(req, res, rootSpan).then(secondPromise)
      registerBlockDelegation(req, res, rootSpan).then(thirdPromise)

      const blocked = callBlockDelegation(res)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnce(rootSpan.setTag)
      sinon.assert.calledOnce(res.writeHead)
      sinon.assert.calledOnce(res.constructor.prototype.end)
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)

      firstPromise.then((blocked) => {
        assert.strictEqual(blocked, true)

        setTimeout(() => {
          sinon.assert.notCalled(secondPromise)
          sinon.assert.notCalled(thirdPromise)
          done()
        }, 100)
      })
    })

    it('should do nothing if no blocking delegation exists', () => {
      const blocked = callBlockDelegation(res)

      assert.ok(!(blocked))
      sinon.assert.notCalled(log.warn)
      sinon.assert.notCalled(rootSpan.setTag)
      sinon.assert.notCalled(res.writeHead)
      sinon.assert.notCalled(res.constructor.prototype.end)
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)
    })

    it('should cancel block delegations when block is called', (done) => {
      const promise = sinon.stub()

      registerBlockDelegation(req, res, rootSpan).then(promise)

      const blocked = block(req, res, rootSpan)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnce(rootSpan.setTag)
      sinon.assert.calledOnce(res.writeHead)
      sinon.assert.calledOnce(res.constructor.prototype.end)
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)

      const result = callBlockDelegation(res)

      assert.ok(!(result))
      sinon.assert.calledOnce(rootSpan.setTag)
      sinon.assert.calledOnce(res.writeHead)
      sinon.assert.calledOnce(res.constructor.prototype.end)
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)

      setTimeout(() => {
        sinon.assert.notCalled(promise)
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

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, defaultBlockedTemplate.html)
    })

    it('should block with default json template', () => {
      setTemplates(config)

      const blocked = block(req, res, rootSpan)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, defaultBlockedTemplate.json)
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

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithMatch(res.writeHead, 401)
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, defaultBlockedTemplate.html)
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

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithMatch(res.writeHead, 401)
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, defaultBlockedTemplate.json)
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

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithMatch(res.writeHead, 401)
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, defaultBlockedTemplate.html)
    })

    it('should block with default json template and custom status', () => {
      const actionParameters = {
        status_code: 401,
        type: 'auto'
      }
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithMatch(res.writeHead, 401)
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, defaultBlockedTemplate.json)
    })

    it('should block with default json template and custom status ' +
      'when type is forced to json and accept is not defined', () => {
      const actionParameters = {
        status_code: 401,
        type: 'json'
      }
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithMatch(res.writeHead, 401)
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, defaultBlockedTemplate.json)
    })

    it('should block with default html template and custom status ' +
      'when type is forced to html and accept is not defined', () => {
      const actionParameters = {
        status_code: 401,
        type: 'html'
      }
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithMatch(res.writeHead, 401)
      sinon.assert.calledOnceWithExactly(res.constructor.prototype.end, defaultBlockedTemplate.html)
    })

    it('should block with custom redirect', () => {
      const actionParameters = {
        status_code: 301,
        location: '/you-have-been-blocked'
      }
      setTemplates(config)

      const blocked = block(req, res, rootSpan, null, actionParameters)

      assert.strictEqual(blocked, true)
      sinon.assert.calledOnceWithExactly(res.writeHead, 301, {
        Location: '/you-have-been-blocked'
      })
      sinon.assert.calledOnce(res.constructor.prototype.end)
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
    assert.deepStrictEqual(blocking.getBlockingAction(actions), blockRequestActionParameters)
  })

  it('get redirect_request as blocking action', () => {
    const redirectRequestActionParameters = {
      status_code: 301
    }

    const actions = {
      redirect_request: redirectRequestActionParameters
    }
    assert.deepStrictEqual(blocking.getBlockingAction(actions), redirectRequestActionParameters)
  })

  it('get undefined when no actions', () => {
    const actions = {}
    assert.strictEqual(blocking.getBlockingAction(actions), undefined)
  })

  it('get undefined when generate_stack action', () => {
    const actions = {
      generate_stack: {}
    }
    assert.strictEqual(blocking.getBlockingAction(actions), undefined)
  })
})
