'use strict'

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

  let log
  let block, setTemplates
  let req, res, rootSpan

  beforeEach(() => {
    log = {
      warn: sinon.stub()
    }

    const blocking = proxyquire('../src/appsec/blocking', {
      '../log': log,
      './blocked_templates': defaultBlockedTemplate
    })

    block = blocking.block
    setTemplates = blocking.setTemplates

    req = {
      headers: {}
    }

    res = {
      setHeader: sinon.stub(),
      writeHead: sinon.stub(),
      end: sinon.stub()
    }
    res.writeHead.returns(res)

    rootSpan = {
      addTags: sinon.stub()
    }
  })

  describe('block', () => {
    beforeEach(() => {
      setTemplates(config)
    })

    it('should log warn and not send blocking response when headers have already been sent', () => {
      res.headersSent = true
      block(req, res, rootSpan)

      expect(log.warn).to.have.been
        .calledOnceWithExactly('Cannot send blocking response when headers have already been sent')
      expect(rootSpan.addTags).to.not.have.been.called
      expect(res.setHeader).to.not.have.been.called
      expect(res.end).to.not.have.been.called
    })

    it('should send blocking response with html type if present in the headers', () => {
      req.headers.accept = 'text/html'
      block(req, res, rootSpan)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': 12
      })
      expect(res.end).to.have.been.calledOnceWithExactly('htmlBodyéé')
    })

    it('should send blocking response with json type if present in the headers in priority', () => {
      req.headers.accept = 'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8, application/json'
      block(req, res, rootSpan)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      expect(res.end).to.have.been.calledOnceWithExactly('jsonBody')
    })

    it('should send blocking response with json type if neither html or json is present in the headers', () => {
      block(req, res, rootSpan)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      expect(res.end).to.have.been.calledOnceWithExactly('jsonBody')
    })

    it('should send blocking response and call abortController if passed in arguments', () => {
      const abortController = new AbortController()
      block(req, res, rootSpan, abortController)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(res.writeHead).to.have.been.calledOnceWithExactly(403, {
        'Content-Type': 'application/json',
        'Content-Length': 8
      })
      expect(res.end).to.have.been.calledOnceWithExactly('jsonBody')
      expect(abortController.signal.aborted).to.be.true
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

      block(req, res, rootSpan)

      expect(res.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.html)
    })

    it('should block with default json template', () => {
      setTemplates(config)

      block(req, res, rootSpan)

      expect(res.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.json)
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

      block(req, res, rootSpan, null, actionParameters)

      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.html)
    })

    it('should block with default json template and custom status ' +
        'when type is forced to json and accept is html', () => {
      const actionParameters = {
        status_code: 401,
        type: 'json'
      }
      req.headers.accept = 'text/html'
      setTemplates(config)

      block(req, res, rootSpan, null, actionParameters)

      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.json)
    })

    it('should block with default html template and custom status ' +
        'when type is forced to html and accept is html', () => {
      const actionParameters = {
        status_code: 401,
        type: 'html'
      }
      req.headers.accept = 'text/html'
      setTemplates(config)

      block(req, res, rootSpan, null, actionParameters)

      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.html)
    })

    it('should block with default json template and custom status', () => {
      const actionParameters = {
        status_code: 401,
        type: 'auto'
      }
      setTemplates(config)

      block(req, res, rootSpan, null, actionParameters)

      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.json)
    })

    it('should block with default json template and custom status ' +
        'when type is forced to json and accept is not defined', () => {
      const actionParameters = {
        status_code: 401,
        type: 'json'
      }
      setTemplates(config)

      block(req, res, rootSpan, null, actionParameters)

      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.json)
    })

    it('should block with default html template and custom status ' +
        'when type is forced to html and accept is not defined', () => {
      const actionParameters = {
        status_code: 401,
        type: 'html'
      }
      setTemplates(config)

      block(req, res, rootSpan, null, actionParameters)

      expect(res.writeHead).to.have.been.calledOnceWith(401)
      expect(res.end).to.have.been.calledOnceWithExactly(defaultBlockedTemplate.html)
    })

    it('should block with custom redirect', () => {
      const actionParameters = {
        status_code: 301,
        location: '/you-have-been-blocked'
      }
      setTemplates(config)

      block(req, res, rootSpan, null, actionParameters)

      expect(res.writeHead).to.have.been.calledOnceWithExactly(301, {
        Location: '/you-have-been-blocked'
      })
      expect(res.end).to.have.been.calledOnce
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
