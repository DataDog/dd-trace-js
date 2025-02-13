'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { assert } = require('chai')
const { channel } = require('../src/helpers/instrument')
const names = ['url', 'node:url']

names.forEach(name => {
  describe(name, () => {
    const url = require(name)
    const parseFinishedChannel = channel('datadog:url:parse:finish')
    const urlGetterChannel = channel('datadog:url:getter:finish')
    let parseFinishedChannelCb, urlGetterChannelCb

    before(async () => {
      await agent.load('url')
    })

    after(() => {
      return agent.close()
    })

    beforeEach(() => {
      parseFinishedChannelCb = sinon.stub()
      urlGetterChannelCb = sinon.stub()
      parseFinishedChannel.subscribe(parseFinishedChannelCb)
      urlGetterChannel.subscribe(urlGetterChannelCb)
    })

    afterEach(() => {
      parseFinishedChannel.unsubscribe(parseFinishedChannelCb)
      urlGetterChannel.unsubscribe(urlGetterChannelCb)
    })

    describe('url.parse', () => {
      it('should publish', () => {
        const result = url.parse('https://www.datadoghq.com')

        sinon.assert.calledOnceWithExactly(parseFinishedChannelCb, {
          input: 'https://www.datadoghq.com',
          parsed: result,
          isURL: false
        }, sinon.match.any)
      })
    })

    describe('url.URL', () => {
      describe('new URL', () => {
        it('should publish with input', () => {
          const result = new url.URL('https://www.datadoghq.com')

          sinon.assert.calledOnceWithExactly(parseFinishedChannelCb, {
            input: 'https://www.datadoghq.com',
            base: undefined,
            parsed: result,
            isURL: true
          }, sinon.match.any)
        })

        it('should publish with base and input', () => {
          const result = new url.URL('/path', 'https://www.datadoghq.com')

          sinon.assert.calledOnceWithExactly(parseFinishedChannelCb, {
            base: 'https://www.datadoghq.com',
            input: '/path',
            parsed: result,
            isURL: true
          }, sinon.match.any)
        })

        it('instanceof should work also for original instances', () => {
          const OriginalUrl = Object.getPrototypeOf(url.URL)
          const originalUrl = new OriginalUrl('https://www.datadoghq.com')

          assert.isTrue(originalUrl instanceof url.URL)
        })

        ;['host', 'origin', 'hostname'].forEach(property => {
          it(`should publish on get ${property}`, () => {
            const urlObject = new url.URL('/path', 'https://www.datadoghq.com')

            const result = urlObject[property]

            sinon.assert.calledWithExactly(urlGetterChannelCb, {
              urlObject,
              result,
              property
            }, sinon.match.any)
          })
        })
      })
    })

    if (url.URL.parse) { // added in v22.1.0
      describe('url.URL.parse', () => {
        it('should publish with input', () => {
          const input = 'https://www.datadoghq.com'
          const parsed = url.URL.parse(input)

          sinon.assert.calledOnceWithExactly(parseFinishedChannelCb, {
            input,
            parsed,
            base: undefined,
            isURL: true
          }, sinon.match.any)
        })

        it('should publish with base and input', () => {
          const result = new url.URL('/path', 'https://www.datadoghq.com')

          sinon.assert.calledOnceWithExactly(parseFinishedChannelCb, {
            base: 'https://www.datadoghq.com',
            input: '/path',
            parsed: result,
            isURL: true
          }, sinon.match.any)
        })
      })
    }
  })
})
