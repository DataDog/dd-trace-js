'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { channel } = require('../src/helpers/instrument')
const names = ['querystring', 'node:querystring']

names.forEach(name => {
  describe(name, () => {
    const querystring = require(name)
    const querystringParseCh = channel('datadog:querystring:parse:finish')
    let querystringParseChCb

    before(async () => {
      await agent.load('querystring')
    })

    after(() => {
      return agent.close()
    })

    beforeEach(() => {
      querystringParseChCb = sinon.stub()
      querystringParseCh.subscribe(querystringParseChCb)
    })

    afterEach(() => {
      querystringParseCh.unsubscribe(querystringParseChCb)
    })

    describe('querystring.parse', () => {
      it('should publish parsed empty query string', () => {
        const result = querystring.parse('')

        sinon.assert.calledOnceWithExactly(querystringParseChCb, {
          qs: result
        }, sinon.match.any)
      })

      it('should publish parsed query string with single parameter', () => {
        const result = querystring.parse('foo=bar')

        sinon.assert.calledOnceWithExactly(querystringParseChCb, {
          qs: result
        }, sinon.match.any)

        expect(result).to.deep.equal({ foo: 'bar' })
      })

      it('should publish parsed query string with multiple parameters', () => {
        const result = querystring.parse('foo=bar&baz=qux')

        sinon.assert.calledOnceWithExactly(querystringParseChCb, {
          qs: result
        }, sinon.match.any)

        expect(result).to.deep.equal({ foo: 'bar', baz: 'qux' })
      })

      it('should publish parsed query string with encoded values', () => {
        const result = querystring.parse('message=hello%20world')

        sinon.assert.calledOnceWithExactly(querystringParseChCb, {
          qs: result
        }, sinon.match.any)

        expect(result).to.deep.equal({ message: 'hello world' })
      })

      it('should publish parsed query string with array parameter', () => {
        const result = querystring.parse('items=1&items=2')

        sinon.assert.calledOnceWithExactly(querystringParseChCb, {
          qs: result
        }, sinon.match.any)

        expect(result).to.have.property('items')
      })

      it('should handle null or undefined query string', () => {
        const result = querystring.parse(null)

        sinon.assert.calledOnceWithExactly(querystringParseChCb, {
          qs: result
        }, sinon.match.any)

        expect(result).to.deep.equal({})
      })
    })
  })
})
