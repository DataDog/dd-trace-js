'use strict'

const { AbortController } = require('node-abort-controller')

describe('blocking', () => {
  const config = {
    appsec: {
      blockedTemplateHtml: 'htmlPath',
      blockedTemplateJson: 'jsonPath'
    }
  }

  let fs
  let block, loadTemplates, loadTemplatesAsync, resetTemplates
  let req, res, rootSpan

  beforeEach(() => {
    fs = {
      readFileSync: sinon.stub().callsFake(getBody),
      promises: {
        readFile: sinon.stub()
      }
    }

    const blocking = proxyquire('../src/appsec/blocking', { fs })

    block = blocking.block
    loadTemplates = blocking.loadTemplates
    loadTemplatesAsync = blocking.loadTemplatesAsync
    resetTemplates = blocking.resetTemplates

    req = {
      headers: {}
    }

    res = {
      setHeader: sinon.stub(),
      end: sinon.stub()
    }

    rootSpan = {
      addTags: sinon.stub()
    }
  })

  describe('block', () => {
    beforeEach(() => {
      loadTemplates(config)
    })

    afterEach(() => {
      resetTemplates()
    })

    it('should send blocking response with html type if present in the headers', () => {
      req.headers.accept = 'text/html'
      block(req, res, rootSpan)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(res.setHeader).to.have.been.calledTwice
      expect(res.setHeader.firstCall).to.have.been.calledWithExactly('Content-Type', 'text/html')
      expect(res.setHeader.secondCall).to.have.been.calledWithExactly('Content-Length', 12)
      expect(res.end).to.have.been.calledOnceWithExactly('htmlBodyéé')
    })

    it('should send blocking response with json type if present in the headers in priority', () => {
      req.headers.accept = 'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8, application/json'
      block(req, res, rootSpan)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(res.setHeader).to.have.been.calledTwice
      expect(res.setHeader.firstCall).to.have.been.calledWithExactly('Content-Type', 'application/json')
      expect(res.setHeader.secondCall).to.have.been.calledWithExactly('Content-Length', 8)
      expect(res.end).to.have.been.calledOnceWithExactly('jsonBody')
    })

    it('should send blocking response with json type if neither html or json is present in the headers', () => {
      block(req, res, rootSpan)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(res.setHeader).to.have.been.calledTwice
      expect(res.setHeader.firstCall).to.have.been.calledWithExactly('Content-Type', 'application/json')
      expect(res.setHeader.secondCall).to.have.been.calledWithExactly('Content-Length', 8)
      expect(res.end).to.have.been.calledOnceWithExactly('jsonBody')
    })

    it('should send blocking response and call abortController if passed in arguments', () => {
      const abortController = new AbortController()
      block(req, res, rootSpan, abortController)

      expect(rootSpan.addTags).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(res.setHeader).to.have.been.calledTwice
      expect(res.setHeader.firstCall).to.have.been.calledWithExactly('Content-Type', 'application/json')
      expect(res.setHeader.secondCall).to.have.been.calledWithExactly('Content-Length', 8)
      expect(res.end).to.have.been.calledOnceWithExactly('jsonBody')
      expect(abortController.signal.aborted).to.be.true
    })
  })

  describe('loadTemplates', () => {
    afterEach(() => {
      resetTemplates()
    })

    describe('sync', () => {
      it('should not read templates more than once if templates are already loaded', () => {
        loadTemplates(config)

        expect(fs.readFileSync).to.have.been.calledTwice
        expect(fs.readFileSync.firstCall).to.have.been.calledWithExactly('htmlPath')
        expect(fs.readFileSync.secondCall).to.have.been.calledWithExactly('jsonPath')

        fs.readFileSync.resetHistory()

        loadTemplates(config)
        loadTemplates(config)

        expect(fs.readFileSync).to.not.have.been.called
      })

      it('should read templates twice if resetTemplates is called', () => {
        loadTemplates(config)

        expect(fs.readFileSync).to.have.been.calledTwice
        expect(fs.readFileSync.firstCall).to.have.been.calledWithExactly('htmlPath')
        expect(fs.readFileSync.secondCall).to.have.been.calledWithExactly('jsonPath')

        fs.readFileSync.resetHistory()
        resetTemplates()

        loadTemplates(config)

        expect(fs.readFileSync).to.have.been.calledTwice
        expect(fs.readFileSync.firstCall).to.have.been.calledWithExactly('htmlPath')
        expect(fs.readFileSync.secondCall).to.have.been.calledWithExactly('jsonPath')
      })
    })

    describe('async', () => {
      it('should not read templates more than once if templates are already loaded', async () => {
        await loadTemplatesAsync(config)

        expect(fs.promises.readFile).to.have.been.calledTwice
        expect(fs.promises.readFile.firstCall).to.have.been.calledWithExactly('htmlPath')
        expect(fs.promises.readFile.secondCall).to.have.been.calledWithExactly('jsonPath')

        fs.promises.readFile.resetHistory()

        await loadTemplatesAsync(config)
        await loadTemplatesAsync(config)

        expect(fs.promises.readFile).to.not.have.been.called
      })

      it('should read templates twice if resetTemplates is called', async () => {
        await loadTemplatesAsync(config)

        expect(fs.promises.readFile).to.have.been.calledTwice
        expect(fs.promises.readFile.firstCall).to.have.been.calledWithExactly('htmlPath')
        expect(fs.promises.readFile.secondCall).to.have.been.calledWithExactly('jsonPath')

        fs.promises.readFile.resetHistory()
        resetTemplates()

        await loadTemplatesAsync(config)

        expect(fs.promises.readFile).to.have.been.calledTwice
        expect(fs.promises.readFile.firstCall).to.have.been.calledWithExactly('htmlPath')
        expect(fs.promises.readFile.secondCall).to.have.been.calledWithExactly('jsonPath')
      })
    })

    describe('mixed sync/async', () => {
      it('should not read templates more than once if templates are already loaded', () => {
        loadTemplates(config)

        expect(fs.readFileSync).to.have.been.calledTwice
        expect(fs.readFileSync.firstCall).to.have.been.calledWithExactly('htmlPath')
        expect(fs.readFileSync.secondCall).to.have.been.calledWithExactly('jsonPath')

        fs.readFileSync.resetHistory()

        loadTemplatesAsync(config)
        loadTemplatesAsync(config)

        expect(fs.readFileSync).to.not.have.been.called
        expect(fs.promises.readFile).to.not.have.been.called
      })

      it('should read templates twice if resetTemplates is called', async () => {
        loadTemplates(config)

        expect(fs.readFileSync).to.have.been.calledTwice
        expect(fs.readFileSync.firstCall).to.have.been.calledWithExactly('htmlPath')
        expect(fs.readFileSync.secondCall).to.have.been.calledWithExactly('jsonPath')

        fs.readFileSync.resetHistory()
        resetTemplates()

        await loadTemplatesAsync(config)

        expect(fs.readFileSync).to.not.have.been.called
        expect(fs.promises.readFile).to.have.been.calledTwice
        expect(fs.promises.readFile.firstCall).to.have.been.calledWithExactly('htmlPath')
        expect(fs.promises.readFile.secondCall).to.have.been.calledWithExactly('jsonPath')
      })
    })
  })
})

function getBody (path) {
  if (path === 'htmlPath') return 'htmlBodyéé'
  if (path === 'jsonPath') return 'jsonBody'
}
