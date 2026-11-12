'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../../../datadog-core')
const agent = require('../../plugins/agent')
const { getConfigFresh } = require('../../helpers/config')
const Reporter = require('../../../src/appsec/reporter')
const ssrf = require('../../../src/appsec/rasp/ssrf')
const Span = require('../../../src/opentracing/span')
const web = require('../../../src/plugins/util/web')
const { withRequest } = require('../../../src/appsec/store')
const waf = require('../../../src/appsec/waf')

const rules = {
  version: '2.2',
  processors: [{
    ...require('../attacker-fingerprinting-rules.json').processors[0],
    conditions: [{
      operator: 'exists',
      parameters: { inputs: [{ address: 'server.io.net.response.status' }] },
    }],
  }],
  rules: [{
    id: 'redirect',
    name: 'redirect',
    tags: { type: 'test', category: 'test' },
    conditions: [{
      operator: 'exact_match',
      parameters: { inputs: [{ address: 'server.io.net.response.status' }], list: ['302'] },
    }],
    output: {
      event: false,
      keep: false,
      attributes: {
        'api.security.redirection.move_target': { address: 'server.io.net.response.headers', key_path: ['location'] },
      },
    },
  }, {
    id: 'later-hop',
    name: 'later hop',
    tags: { type: 'ssrf', category: 'test' },
    conditions: [{
      operator: 'match_regex',
      parameters: { inputs: [{ address: 'server.io.net.url' }], regex: '/danger$' },
    }],
    on_match: ['block'],
    output: { keep: false },
  }, {
    id: 'cross-hop',
    name: 'Conditions must match the same outgoing request',
    tags: { type: 'ssrf', category: 'test' },
    conditions: [{
      operator: 'match_regex',
      parameters: { inputs: [{ address: 'server.io.net.url' }], regex: '/a$' },
    }, {
      operator: 'exact_match',
      parameters: {
        inputs: [{ address: 'server.io.net.request.headers', key_path: ['x-mark'] }], list: ['yes'],
      },
    }],
    on_match: ['block'],
    output: { keep: false },
  }, {
    id: 'stale-response',
    name: 'stale response',
    tags: { type: 'test', category: 'test' },
    conditions: [{
      operator: 'match_regex',
      parameters: { inputs: [{ address: 'server.io.net.url' }], regex: '/final$' },
    }, {
      operator: 'exact_match',
      parameters: {
        inputs: [{ address: 'server.io.net.response.headers', key_path: ['x-stale'] }], list: ['yes'],
      },
    }],
    output: { keep: false },
  }],
}

describe('SSRF redirect reporting', () => {
  let http, server, baseUrl, req, span

  before(async () => {
    await agent.load('http')
    http = require('node:http')
    server = http.createServer((req, res) => {
      const path = new URL(req.url, 'http://localhost').pathname
      const targets = {
        '/a': '/shared',
        '/b': '/shared',
        '/shared': '/final',
        '/attack': '/danger',
        '/broken': '/disconnect',
      }
      if (path === '/disconnect') {
        req.socket.destroy()
        return
      }
      if (targets[path]) {
        res.writeHead(302, { location: targets[path], 'x-stale': 'yes' })
      } else if (path === '/invalid') {
        res.writeHead(302, { location: 'http://[' })
      }
      res.end('OK')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await agent.close()
  })

  beforeEach(() => {
    req = {}
    span = new Span({ _config: {} }, {}, {}, { operationName: 'web.request' })
    sinon.stub(web, 'root').withArgs(req).returns(span)
    sinon.stub(Reporter, 'reportAttack')
    sinon.stub(Reporter, 'reportMetrics')
    const config = getConfigFresh()
    waf.init(rules, { ...config.appsec, DD_APPSEC_WAF_TIMEOUT: 100000 })
    ssrf.enable(config)
  })

  afterEach(() => {
    ssrf.disable()
    waf.disposeContext(req)
    waf.destroy()
    sinon.restore()
  })

  /** @param {() => Promise<unknown>} fn Outgoing work for one incoming request. */
  function incoming (fn) {
    return storage('legacy').run(withRequest(storage('legacy').getStore(), req), fn)
  }

  /**
   * @param {string} path Initial path.
   * @param {'callback'|'end'|'async'} mode Where to follow redirects.
   */
  function follow (path, mode = 'callback') {
    return new Promise((resolve, reject) => {
      const request = http.get(baseUrl + path, res => {
        const next = res.headers.location
        if (res.statusCode === 302 && next) {
          const proceed = () => follow(next, mode).then(resolve, reject)
          if (mode === 'end') res.once('end', proceed)
          else if (mode === 'async') setImmediate(proceed)
          else proceed()
        } else {
          res.once('end', resolve)
        }
        res.resume()
      })
      request.on('error', reject)
    })
  }

  for (const mode of ['callback', 'end', 'async']) {
    it(`keeps the first redirect when following from ${mode}`, async () => {
      await incoming(() => follow('/a', mode))
      assert.strictEqual(span.context().getTag('api.security.redirection.move_target'), '/shared')
      sinon.assert.notCalled(Reporter.reportAttack)
      assert.strictEqual(waf.wafManager.getWAFContext(req).subcontexts.size, 0)
    })
  }

  it('keeps the first target across outgoing requests but isolates incoming requests', async () => {
    await incoming(() => follow('/a'))
    await incoming(() => follow('/shared'))
    assert.strictEqual(span.context().getTag('api.security.redirection.move_target'), '/shared')
    waf.disposeContext(req)
    req = {}
    span = new Span({ _config: {} }, {}, {}, { operationName: 'web.request' })
    web.root.withArgs(req).returns(span)
    await incoming(() => follow('/shared'))
    assert.strictEqual(span.context().getTag('api.security.redirection.move_target'), '/final')
  })

  it('keeps redirect order when the first response finishes after the later hops', async () => {
    await incoming(() => new Promise((resolve, reject) => {
      http.get(baseUrl + '/a', res => {
        follow(res.headers.location).then(() => {
          res.once('end', resolve)
          res.resume()
        }, reject)
      }).on('error', reject)
    }))
    assert.strictEqual(span.context().getTag('api.security.redirection.move_target'), '/shared')
  })

  it('does not combine conditions from different requests in a redirect chain', async () => {
    await incoming(() => new Promise((resolve, reject) => {
      http.get(baseUrl + '/a', res => {
        http.get(baseUrl + res.headers.location, { headers: { 'x-mark': 'yes' } }, next => {
          next.once('end', resolve)
          next.resume()
        }).on('error', reject)
        res.resume()
      }).on('error', reject)
    }))
    sinon.assert.notCalled(Reporter.reportAttack)
  })

  it('detects a dangerous later hop and retains its blocking action', async () => {
    await incoming(() => follow('/attack'))
    assert.strictEqual(span.context().getTag('api.security.redirection.move_target'), '/danger')
    sinon.assert.calledOnce(Reporter.reportAttack)
    const result = Reporter.reportAttack.firstCall.args[0]
    assert.strictEqual(result.events[0].rule.id, 'later-hop')
    assert.strictEqual(result.actions.block_request.status_code, 403)
  })

  it('updates fingerprints produced during response evaluation', async () => {
    waf.run({ 'server.request.method': 'POST', 'server.request.uri.raw': '/incoming' }, req)
    await incoming(() => follow('/a'))
    const firstFingerprint = span.context().getTag('_dd.appsec.fp.http.endpoint')
    assert.strictEqual(typeof firstFingerprint, 'string')

    waf.run({ 'server.request.body': { hello: 'world' } }, req)
    await incoming(() => follow('/a'))
    const nextFingerprint = span.context().getTag('_dd.appsec.fp.http.endpoint')
    assert.strictEqual(typeof nextFingerprint, 'string')
    assert.notStrictEqual(nextFingerprint, firstFingerprint)
    assert.strictEqual(span.context().getTag('api.security.redirection.move_target'), '/shared')
  })

  it('updates non-redirect response attributes added by remote configuration', async () => {
    const redirectRule = rules.rules[0]
    waf.updateConfig('ASM', 'redirect', 'custom/redirect', {
      custom_rules: [{
        ...redirectRule,
        id: 'custom-redirect',
        output: {
          ...redirectRule.output,
          attributes: {
            ...redirectRule.output.attributes,
            'custom.output': redirectRule.output.attributes['api.security.redirection.move_target'],
          },
        },
      }],
    })
    await incoming(() => follow('/a'))
    assert.strictEqual(span.context().getTag('custom.output'), '/final')
    assert.strictEqual(span.context().getTag('api.security.redirection.move_target'), '/shared')
  })

  it('cleans up an interrupted chain with the incoming request', async () => {
    await assert.rejects(incoming(() => follow('/broken')), { code: 'ECONNRESET' })
    const context = waf.wafManager.getWAFContext(req)
    assert.strictEqual(context.subcontexts.size, 1)
    waf.disposeContext(req)
    assert.strictEqual(context.subcontexts.size, 0)
  })

  it('ignores invalid Location values and completes cleanup', async () => {
    await incoming(() => new Promise((resolve, reject) => {
      http.get(baseUrl + '/invalid', res => {
        res.resume()
        res.once('end', resolve)
      }).on('error', reject)
    }))
    assert.strictEqual(span.context().getTag('api.security.redirection.move_target'), 'http://[')
    assert.strictEqual(waf.wafManager.getWAFContext(req).subcontexts.size, 0)
  })
})
