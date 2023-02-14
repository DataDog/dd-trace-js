'use strict'

const fs = require('fs')
const sinon = require('sinon')

describe('blocking', () => {
  const { block, loadTemplates, loadTemplatesAsync, resetTemplates } = require('../../src/appsec/blocking')
  let req = {
    headers: {
      accept: 'text/html'
    }
  }
  let res, rootSpan

  describe('block', () => {
    let setHeaderStub, endStub, addTagsStub

    beforeEach(() => {
      setHeaderStub = sinon.stub()
      endStub = sinon.stub()
      addTagsStub = sinon.stub()

      res = {
        setHeader: setHeaderStub,
        end: endStub
      }

      rootSpan = {
        addTags: addTagsStub
      }
    })

    it('should call setHeader with text/html type if present in the headers', () => {
      block(req, res, rootSpan)
      expect(addTagsStub).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(setHeaderStub).to.have.been.calledTwice
      expect(setHeaderStub).to.have.been.calledWithExactly('Content-Type', 'text/html')
      expect(endStub).to.have.been.calledOnce
    })

    it('should call setHeader with json type if present in the headers', () => {
      req.headers.accept = 'application/json'
      block(req, res, rootSpan)

      expect(addTagsStub).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(setHeaderStub).to.have.been.calledTwice
      expect(setHeaderStub).to.have.been.calledWithExactly('Content-Type', 'application/json')
      expect(endStub).to.have.been.calledOnce
    })

    it('should call setHeader with json type if neither html or json is present in the headers', () => {
      req.headers.accept = 'whatever'
      block(req, res, rootSpan)

      expect(addTagsStub).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(setHeaderStub).to.have.been.calledTwice
      expect(setHeaderStub).to.have.been.calledWithExactly('Content-Type', 'application/json')
      expect(endStub).to.have.been.calledOnce
    })
  })

  describe('loadTemplates', () => {
    let setHeaderStub, endStub, addTagsStub
    const body = 'bodyContent'
    const config = {
      appsec: {
      }
    }

    beforeEach(() => {
      sinon.stub(fs, 'readFileSync').returns(body)
      sinon.stub(fs.promises, 'readFile').returns(body)
      setHeaderStub = sinon.stub()
      endStub = sinon.stub()
      addTagsStub = sinon.stub()

      req = {
        headers: {
          accept: 'text/html'
        }
      }

      res = {
        setHeader: setHeaderStub,
        end: endStub
      }

      rootSpan = {
        addTags: addTagsStub
      }
    })

    afterEach(() => {
      resetTemplates()
      sinon.restore()
    })

    it('loadTemplates should call end with the contents read from file', () => {
      loadTemplates(config)
      block(req, res, rootSpan)

      expect(addTagsStub).to.have.been.calledOnceWithExactly({ 'appsec.blocked': 'true' })
      expect(setHeaderStub).to.have.been.calledTwice
      expect(setHeaderStub).to.have.been.calledWithExactly('Content-Type', 'text/html')
      expect(endStub).to.have.been.calledOnceWithExactly(body)
    })

    it('loadTemplates hould not call readFileSync more than twice if templates are already loaded', () => {
      loadTemplates(config)
      expect(fs.readFileSync).to.have.been.calledTwice

      fs.readFileSync.reset()

      loadTemplates(config)
      expect(fs.readFileSync).not.to.have.been.called
    })

    it('loadTemplates should call readFileSync more than twice if resetTemplates is called', () => {
      loadTemplates(config)
      expect(fs.readFileSync).to.have.been.calledTwice

      fs.readFileSync.reset()
      resetTemplates()

      loadTemplates(config)
      expect(fs.readFileSync).to.have.been.calledTwice
    })

    it('loadTemplatesAsync should not call readFile more than twice if templates are already loaded', () => {
      loadTemplatesAsync(config).then(() => {
        expect(fs.promises.readFile).to.have.been.calledTwice
      })

      fs.promises.readFile.reset()

      loadTemplatesAsync(config).then(() => {
        expect(fs.promises.readFile).not.to.have.been.called
      })
    })

    it('loadTemplatesAsync should call readFile more than twice if resetTemplates is called', () => {
      loadTemplatesAsync(config).then(() => {
        expect(fs.promises.readFile).to.have.been.calledTwice
      })

      fs.promises.readFile.reset()
      resetTemplates()

      loadTemplatesAsync(config).then(() => {
        expect(fs.promises.readFile).to.have.been.calledTwice
      })
    })
  })
})
