'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { channel } = require('../src/helpers/instrument')
const names = ['url', 'node:url']

describe('url ESM loading', () => {
  it('does not instrument the same URL implementation twice', () => {
    const repositoryRoot = path.resolve(__dirname, '../../..')
    const script = [
      "const dc = require('dc-polyfill')",
      'let parseCount = 0',
      'let getterCount = 0',
      "dc.subscribe('datadog:url:parse:finish', () => parseCount++)",
      "dc.subscribe('datadog:url:getter:finish', () => getterCount++)",
      "require('node:url')",
      "import('node:url').then(({ URL }) => {",
      '  const parseCountBefore = parseCount',
      "  const parsed = new URL('https://www.datadoghq.com/path')",
      '  const getterCountBefore = getterCount',
      '  parsed.host',
      '  console.log("URL_COUNTS " + (parseCount - parseCountBefore) + " " + ' +
        '(getterCount - getterCountBefore))',
      '})',
    ].join('\n')
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: '0',
        DD_REMOTE_CONFIG_ENABLED: '0',
        DD_TRACE_AGENT_URL: 'http://127.0.0.1:9',
        DD_TRACE_DEBUG: '1',
        NODE_OPTIONS: `-r ${path.join(repositoryRoot, 'init.js')} ` +
          `--loader ${path.join(repositoryRoot, 'loader-hook.mjs')}`,
      },
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Error during ddtrace instrumentation/)
    assert.match(result.stdout, /URL_COUNTS 1 1/)
  })
})

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
          isURL: false,
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
            isURL: true,
          }, sinon.match.any)
        })

        it('should publish with base and input', () => {
          const result = new url.URL('/path', 'https://www.datadoghq.com')

          sinon.assert.calledOnceWithExactly(parseFinishedChannelCb, {
            base: 'https://www.datadoghq.com',
            input: '/path',
            parsed: result,
            isURL: true,
          }, sinon.match.any)
        })

        it('instanceof should work also for original instances', () => {
          const OriginalUrl = Object.getPrototypeOf(url.URL)
          const originalUrl = new OriginalUrl('https://www.datadoghq.com')

          assert(originalUrl instanceof url.URL)
        })

        ;['host', 'origin', 'hostname'].forEach(property => {
          it(`should publish on get ${property}`, () => {
            const urlObject = new url.URL('/path', 'https://www.datadoghq.com')

            const result = urlObject[property]

            sinon.assert.calledWithExactly(urlGetterChannelCb, {
              urlObject,
              result,
              property,
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
            isURL: true,
          }, sinon.match.any)
        })

        it('should publish with base and input', () => {
          const result = new url.URL('/path', 'https://www.datadoghq.com')

          sinon.assert.calledOnceWithExactly(parseFinishedChannelCb, {
            base: 'https://www.datadoghq.com',
            input: '/path',
            parsed: result,
            isURL: true,
          }, sinon.match.any)
        })
      })
    }
  })
})
