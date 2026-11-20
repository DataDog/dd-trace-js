'use strict'

const assert = require('node:assert/strict')
const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
// path-to-regexp is a transitive (vendored) dependency; require it directly to exercise the
// normalizer against the real Express 5 parser/matcher (path-to-regexp 8).
// eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-require
const { parse: rawParse, match: rawMatch } = require('path-to-regexp')
const { normalizeRoute: normalizeRouteExpress } = require('../../../src/appsec/api_security/normalized-route/express')

// Mirror the getParse instrumentation adapter: TokenData ({ tokens }) or undefined.
function parse (pattern) {
  let result
  try {
    result = rawParse(pattern)
  } catch {
    return undefined
  }
  return Array.isArray(result?.tokens) ? result : undefined
}

// Mirror the getMatch instrumentation adapter: route → (url → captured params | undefined).
function makeMatcher (route) {
  let matcher
  try {
    matcher = rawMatch(route, { decode: false })
  } catch {
    return undefined
  }
  return url => {
    let result
    try {
      result = matcher(url)
    } catch {
      return undefined
    }
    return result ? result.params : undefined
  }
}

function normalize (route, params, urlPath) {
  return normalizeRouteExpress(route, params, urlPath, parse, makeMatcher)
}

// Register one test per case, named after its inputs so a failure names the exact route.
function check (route, url, expected, params = {}) {
  it(`${route}${url === undefined ? '' : ` on ${url}`} → ${expected}`, () => {
    assert.equal(normalize(route, params, url), expected)
  })
}

describe('normalizeRouteExpress', () => {
  describe('invalid / unsupported inputs', () => {
    check(null, undefined, null)
    check('', undefined, null)
    check('/users/:"unterminated', undefined, null)
    check('/users{/:id', undefined, null)
    check('/path(\\.ext)?', undefined, null)

    it('returns null when no parse function is provided (Express 4 / path-to-regexp 0.x)', () => {
      assert.equal(normalizeRouteExpress('/users/:id', {}, '/users/1', undefined), null)
    })
  })

  describe('Express 4 syntax is unsupported (parser throws → null)', () => {
    // A real Express 5 app cannot register these, so omitting the tag is correct.
    check('/users/:id?', undefined, null)
    check('/users/:id(\\d+)', undefined, null, { id: '5' })
    check('/files/*', undefined, null)
    check('/files/:path*', undefined, null)
    check('/api/v:major?/users', undefined, null)
  })

  describe('root and trivial routes', () => {
    check('/', undefined, '/')
    check('/users/', undefined, '/users/')
    check('/users', undefined, '/users')
    check('/a//b', '/a/b', '/a/b')
  })

  describe('static routes', () => {
    check('/api/v1/users', undefined, '/api/v1/users')
    check('/api/v2.0/some-path', undefined, '/api/v2.0/some-path')
  })

  describe('required named params', () => {
    check('/users/:id', undefined, '/users/{id}', { id: '123' })
    check('/users/:userId/posts/:postId', undefined, '/users/{userId}/posts/{postId}',
      { userId: '1', postId: '2' })
    check('/api/v1/users/:id', undefined, '/api/v1/users/{id}', { id: '42' })
    check('/users/:id', undefined, '/users/{id}', null)
    check('/:$foo', '/x', '/{$foo}', { $foo: 'x' })
    check('/:café', '/x', '/{café}', { café: 'x' })
  })

  describe('multi-param segments (rule 5)', () => {
    check('/photos/:id.:format', undefined, '/photos/{id+format}', { id: '1', format: 'jpg' })
    check('/v/:major.:minor.:patch', undefined, '/v/{major+minor+patch}',
      { major: '1', minor: '2', patch: '3' })
    check('/users/user-:id', undefined, '/users/{id}', { id: '5' })
  })

  describe('Express 5 named wildcard (*name)', () => {
    check('/*splat', undefined, '/{splat}', { splat: 'anything' })
    check('/files/*rest', undefined, '/files/{rest}', { rest: 'a/b/c' })
    check('/:param1/:param2/*', undefined, null, { param1: 'x', param2: 'y' })
    check('/:param1/:param2/*rest', undefined, '/{param1}/{param2}/{rest}',
      { param1: 'x', param2: 'y', rest: 'z' })
  })

  describe('non-terminal catch-all (returns null)', () => {
    check('/*splat/edit', undefined, null)
    check('/x{/*rest}/tail', '/x/a/tail', null)
  })

  describe('wildcard with a prefix in its segment', () => {
    check('/files/v*rest', '/files/vY/z', '/files/{rest}')
    check('/x/:a-*rest', '/x/y-z/w', '/x/{a+rest}')
    check('/files{/:opt}/v*rest', '/files/x/vY/z', '/files/{opt}/{rest}')
    check('/files{/:opt}/v*rest', '/files/vY/z', '/files/{rest}')
  })

  describe('mount-prefixed routes and combined cases', () => {
    check('/app/users/:id', undefined, '/app/users/{id}', { id: '5' })
    check('/api/:version/*path', undefined, '/api/{version}/{path}', { version: 'v2', path: 'a/b' })
    check('/users/:id/', undefined, '/users/{id}/', { id: '1' })
  })

  describe('Express 5 {/:param} optional-group syntax', () => {
    check('/items{/:id}', '/items/42', '/items/{id}')
    check('/items{/:id}', '/items', '/items')
    check('/items{/:id}', undefined, '/items/{id}', { id: '42' })
    check('/api{/:version}/users', '/api/v1/users', '/api/{version}/users')
    check('/api{/:version}/users', '/api/users', '/api/users')
    check('/posts{/:id.:format}', '/posts/1.json', '/posts/{id+format}')
    check('/posts{/:id.:format}', '/posts', '/posts')
    check('/files{/*path}', '/files/a/b', '/files/{path}')
    check('/files{/*path}', '/files', '/files')
    check('/users{/:"user-id"}', '/users/42', '/users/{user-id}')
    check('/users{/:"user-id"}', '/users', '/users')
    check('/a{/:b{/:c}}', '/a/x/y', '/a/{b}/{c}')
    check('/a{/:b{/:c}}', '/a/x', '/a/{b}')
    check('/a{/:b{/:c}}', '/a', '/a')
  })

  describe('intra-segment / multi-segment optional param groups (resolved via match)', () => {
    check('/photos/:id{.:format}', '/photos/1.jpg', '/photos/{id+format}')
    check('/photos/:id{.:format}', '/photos/1', '/photos/{id}')
    check('/:a{.:b}{-:c}', '/x.y-z', '/{a+b+c}')
    check('/:a{.:b}{-:c}', '/x-z', '/{a+c}')
    check('/:a{.:b}{-:c}', '/x', '/{a}')
    check('/:a{.:b}-*rest', '/x.y-/def', '/{a+b+rest}')
    check('/:a{.:b}-*rest', '/x-/def', '/{a+rest}')
    check('/x{/:a/:b}', '/x/1/2', '/x/{a}/{b}')
    check('/x{/:a/:b}', '/x', '/x')
    check('{/:a}{/:b/:c}', '/B/C', '/{b}/{c}')
    check('{/:a}{/:b/:c}', '/A/B/C', '/{a}/{b}/{c}')
  })

  describe('mandatory static sharing a segment with an optional group', () => {
    // The trailing static is group-0 (mandatory) but shares the optional group's URL segment; it must
    // survive when the group is absent, not be dropped with the group's leading slash.
    check('/files{/:id}.json', '/files.json', '/files.json')
    check('/files{/:id}.json', '/files/5.json', '/files/{id}') // single-param segment → just the param
    check('/a{/:id}b/c', '/ab/c', '/ab/c')
    check('/a{/:id}b/c', '/a/5b/c', '/a/{id}/c')
    check('/x{/a}{/b}y', '/xy', '/xy') // static-only groups dropped, mandatory 'y' kept
    check('/a{/mid}b', '/ab', '/ab')
  })

  describe('static-only optional groups are dropped (rendered absent)', () => {
    // A static-only optional group carries no param for match() to resolve, so it renders as absent —
    // a stable, minimal route rather than an omitted tag.
    check('/posts{/draft}', '/posts/draft', '/posts')
    check('/posts{/draft}', '/posts', '/posts')
    check('/foo{bar}', '/foobar', '/foo')
    check('/foo{bar}baz', '/foobaz', '/foobaz')
    check('/a{b}{c}', '/abc', '/a')
    check('/a{{/b}}', '/a/b', '/a')
    check('/a{/:id}/p{q}*rest', '/a/1/pZ/w', '/a/{id}/{rest}') // static group dropped, param resolved
    check('/users{/}', '/users/', '/users') // bare optional slash dropped
    check('/items{/:id/}', '/items/42/', '/items/{id}') // optional trailing slash dropped, param kept
  })

  describe('omitted shapes (returns null, not a wrong tag)', () => {
    check('/:id{/:id}', '/x', null, { id: 'x' }) // optional group shares a param name → ambiguous
    check('/a{/:x}/b{/:x}', '/a/b/v', null, { x: 'v' })
    check('/files/*path.:ext', '/files/a/b.txt', null) // non-terminal catch-all
    check('/*a-*b', '/x-y', null)
    check('/a{/b{/:c}}', '/a/b', null) // group detectable only via a nested param → presence ambiguous
  })

  describe('URL-based optional resolution (mergeParams=false fix)', () => {
    // The request URL — not req.params — drives presence, so sub-routers mounted without
    // mergeParams (which drops the parent's optional param) still resolve correctly.
    check('/api{/:version}/users', undefined, '/api/users')
    check('/api{/:version}/users', '/completely/different/path', '/api/{version}/users',
      { version: 'v2' })
    check('/a{/:x}{/:y}/b', '/a/1/2/b', '/a/{x}/{y}/b')
    check('/a{/:x}{/:y}/b', '/a/1/b', '/a/{x}/b')
    check('/a{/:x}{/:y}/b', '/a/b', '/a/b')
    check('/api{/:version}/users{/:id}', '/api/v1/users/42', '/api/{version}/users/{id}',
      { id: '42' })
    check('/files{/:id}/*rest', '/files/x/y/z', '/files/{id}/{rest}')
    // '/files/x': the required '*rest' claims the one segment, so {/:id} is absent (not the reverse).
    check('/files{/:id}/*rest', '/files/x', '/files/{rest}')
  })

  describe('static segment encoding (UTF-8 correctness)', () => {
    check('/path/café', undefined, '/path/caf%C3%A9')
    check('/a/b c', undefined, '/a/b%20c')
    check('/a/b,c', undefined, '/a/b%2Cc')
    check('/path/🚀', undefined, '/path/%F0%9F%9A%80')
    check('/file/\\{id\\}', '/file/{id}', '/file/%7Bid%7D')
  })

  describe('prototype property safety (:toString, :constructor)', () => {
    // Only own enumerable params count; inherited Object.prototype props must not read as present.
    check('/x{/:toString}', undefined, '/x')
    check('/x{/:constructor}', undefined, '/x')
    check('/x{/:toString}', undefined, '/x/{toString}', { toString: 'val' })
  })

  describe('duplicate param names (shadowed occurrences become paramN)', () => {
    // Express keeps only the last value for a duplicated name, so earlier occurrences are numbered
    // paramN in declaration order (RFC rule 4), skipping any surviving framework name.
    check('/:id/:id', '/x/y', '/{param1}/{id}')
    check('/:id/:id/:id', '/x/y/z', '/{param1}/{param2}/{id}')
    check('/:param1/:param1', '/x/y', '/{param2}/{param1}')
    check('/:"a/b"/:"a%2Fb"', '/x/y', '/{param1}/{a%2Fb}')
    check('/:"a\\"b"', '/x', '/{a"b}', { 'a"b': 'x' })
  })

  describe('performance / safety guards', () => {
    const optionals = (n) => '/r' + Array.from({ length: n }, (_, i) => `{/:p${i}}`).join('')
    const url = (n) => '/r' + '/x'.repeat(n)
    const statics = (n) => Array.from({ length: n }, (_, i) => `{s${i}}`).join('')

    it('resolves a route at the optional-group cap (8)', () => {
      assert.equal(normalize(optionals(8), {}, url(8)), '/r/{p0}/{p1}/{p2}/{p3}/{p4}/{p5}/{p6}/{p7}')
    })

    // 9 > cap → omitted before a matcher (an exponential regexp) is ever built.
    it('omits a route just over the optional-group cap (9)', () => {
      assert.equal(normalize(optionals(9), {}, url(9)), null)
    })

    // The cap counts ALL optional groups (match()'s regexp is exponential in the total), not just the
    // resolvable ones: static groups that render as absent still count.
    it('counts static groups toward the cap (7 static + 1 param = 8 total → resolves)', () => {
      assert.equal(normalize('/r' + statics(7) + '{/:id}', {}, '/r/5'), '/r/{id}')
    })

    it('counts static groups toward the cap (8 static + 1 param = 9 total → omitted)', () => {
      assert.equal(normalize('/r' + statics(8) + '{/:id}', {}, '/r/5'), null)
    })
  })
})

describe('normalizeRoute framework selection', () => {
  let normalizeRoute, matchedRoutes, req, component, route, context, web, getParse, getMatch

  beforeEach(() => {
    req = { url: '/items/42', params: {} }
    component = 'fastify'
    route = '/items/:id'
    context = { paths: [route] }
    web = {
      root: sinon.stub().returns({
        context: () => ({ getTag: tag => tag === 'component' ? component : route }),
      }),
      getContext: sinon.stub().returns(context),
    }
    matchedRoutes = proxyquire('../../../src/appsec/api_security/normalized-route/matched-routes', {
      '../../../plugins/util/web': web,
    })
    captureRoute('/items/:id')
    getParse = sinon.stub().returns(parse)
    getMatch = sinon.stub().returns(makeMatcher)
    normalizeRoute = proxyquire('../../../src/appsec/api_security/normalized-route', {
      '../../../../../datadog-instrumentations/src/path-to-regexp': { getParse, getMatch },
      '../../../plugins/util/web': web,
      './matched-routes': matchedRoutes,
    }).normalizeRoute
  })

  /** @param {string | undefined} concrete */
  function captureRoute (concrete) {
    route = concrete
    context.paths = [route]
    matchedRoutes.onRequest({ req, routeOptions: route === undefined ? undefined : { url: route } })
    web.getContext.resetHistory()
  }

  it('normalizes an Express request using the serving app grammar', () => {
    component = 'express'
    route = '/items{/:id}'
    assert.equal(normalizeRoute(req), '/items/{id}')
    sinon.assert.notCalled(web.getContext)
  })

  it('prefers the original Express URL over the rewritten request URL', () => {
    component = 'express'
    route = '/items{/:id}'
    req.originalUrl = '/items/42'
    req.url = '/items'
    assert.equal(normalizeRoute(req), '/items/{id}')
  })

  it('returns null for Express 4 even when a parser is available', () => {
    component = 'express'
    route = '/items/:id'
    req.app = { del () {} }
    assert.equal(normalizeRoute(req), null)
    sinon.assert.notCalled(getParse)
  })

  it('returns null when the Express parser adapter is unavailable', () => {
    component = 'express'
    route = '/items/:id'
    getParse.returns(undefined)
    assert.equal(normalizeRoute(req), null)
  })

  it('normalizes the Fastify declaration without a version field', () => {
    assert.equal(normalizeRoute(req), '/items/{id}')
    captureRoute('/items')
    assert.equal(normalizeRoute(req), '/items')
    sinon.assert.notCalled(getParse)
    sinon.assert.notCalled(getMatch)
  })

  it('keeps Express and Fastify grammars and caches independent', () => {
    route = '/braces{literal}'
    context.paths = [route]
    captureRoute(route)
    for (let i = 0; i < 2; i++) {
      component = 'express'
      assert.equal(normalizeRoute(req), '/braces')
      component = 'fastify'
      assert.equal(normalizeRoute(req), '/braces%7Bliteral%7D')
    }
  })

  it('distinguishes unnamed Fastify catch-alls from Express syntax and avoids name collisions', () => {
    route = '/:param1/*'
    context.paths = [route]
    captureRoute(route)
    assert.equal(normalizeRoute(req), '/{param1}/{param2}')
    component = 'express'
    assert.equal(normalizeRoute(req), null)
  })

  it('does not normalize an unsupported framework', () => {
    component = 'koa'
    assert.equal(normalizeRoute(req), null)
    sinon.assert.notCalled(web.getContext)
    sinon.assert.notCalled(getParse)
  })

  it('does not normalize without an HTTP span', () => {
    web.root.returns(undefined)
    assert.equal(normalizeRoute(req), null)
    sinon.assert.notCalled(web.getContext)
  })

  it('does not normalize without a declared route', () => {
    route = undefined
    assert.equal(normalizeRoute(req), null)
    component = 'express'
    assert.equal(normalizeRoute(req), null)
  })

  it('does not normalize without a web context', () => {
    web.getContext.returns(undefined)
    assert.equal(normalizeRoute(req), null)
  })

  it('does not normalize without a Fastify capture', () => {
    context.paths = [route]
    assert.equal(normalizeRoute(req), null)
  })

  for (const paths of [undefined, [], ['/different'], ['/prefix', '/items/:id?']]) {
    it('omits a Fastify route when its captured declaration differs: ' + JSON.stringify(paths), () => {
      context.paths = paths
      matchedRoutes.onRequest({ req, routeOptions: route === undefined ? undefined : { url: route } })
      assert.equal(normalizeRoute(req), null)
    })
  }

  for (const replacement of ['/users/:id', '/items/:id?']) {
    it('omits a Fastify branch after another route update: ' + replacement, () => {
      route = replacement
      context.paths = [replacement]
      assert.equal(normalizeRoute(req), null)
    })
  }

  const unsupported = [undefined, '', '/items/:id(', '/items/*/tail', 'invalid', '/items/:id?', '/items/:id?/']
  for (const matchedRoute of unsupported) {
    it('omits an unavailable or unsupported Fastify branch: ' + matchedRoute, () => {
      captureRoute(matchedRoute)
      assert.equal(normalizeRoute(req), null)
      assert.equal(normalizeRoute(req), null)
    })
  }
})

for (const framework of ['express', 'fastify']) {
  describe(`normalizeRoute ${framework} cache`, () => {
    let normalizeRoute, renderRoute, parseRoute

    beforeEach(() => {
      const renderer = require('../../../src/appsec/api_security/normalized-route/renderer')
      renderRoute = sinon.spy(renderer.renderRoute)
      parseRoute = sinon.spy(parse)
      normalizeRoute = proxyquire('../../../src/appsec/api_security/normalized-route/' + framework, {
        './renderer': { renderRoute },
      }).normalizeRoute
    })

    /**
     * @param {string} route
     * @param {string} [urlPath]
     */
    function normalize (route, urlPath) {
      return normalizeRoute(route, undefined, urlPath, parseRoute, makeMatcher)
    }

    it('reuses rendered declarations on repeated requests', () => {
      assert.equal(normalize('/cached/:id'), '/cached/{id}')
      assert.equal(normalize('/cached/:id'), '/cached/{id}')
      sinon.assert.calledOnce(renderRoute)
    })

    it('bounds retention while keeping recently used routes cached', () => {
      for (let i = 0; i < 4096; i++) {
        assert.equal(normalize('/tenant-' + i + '/:id'), '/tenant-' + i + '/{id}')
      }
      assert.equal(renderRoute.callCount, 4096)
      assert.equal(normalize('/tenant-0/:id'), '/tenant-0/{id}')
      assert.equal(renderRoute.callCount, 4096)

      assert.equal(normalize('/tenant-4096/:id'), '/tenant-4096/{id}')
      assert.equal(renderRoute.callCount, 4097)
      assert.equal(normalize('/tenant-0/:id'), '/tenant-0/{id}')
      assert.equal(normalize('/tenant-4096/:id'), '/tenant-4096/{id}')
      assert.equal(renderRoute.callCount, 4097)

      // The least recently used declaration was evicted, but recompilation preserves its output.
      assert.equal(normalize('/tenant-1/:id'), '/tenant-1/{id}')
      assert.equal(renderRoute.callCount, 4098)
    })

    it('keeps unsupported declarations omitted before and after eviction', () => {
      assert.equal(normalize('/broken/:id('), null)
      assert.equal(normalize('/broken/:id('), null)
      sinon.assert.notCalled(renderRoute)
      if (framework === 'express') sinon.assert.calledOnce(parseRoute)
      for (let i = 0; i < 4096; i++) normalize('/eviction-' + i)
      assert.equal(normalize('/broken/:id('), null)
      assert.equal(normalize('/broken/:id('), null)
      if (framework === 'express') assert.equal(parseRoute.callCount, 4098)
    })

    if (framework === 'express') {
      it('rebuilds the matcher and optional variants after eviction', () => {
        const route = '/optional{/:id}'
        assert.equal(normalize(route, '/optional/42'), '/optional/{id}')
        assert.equal(normalize(route, '/optional'), '/optional')
        assert.equal(normalize(route, '/optional/42'), '/optional/{id}')
        sinon.assert.calledOnce(parseRoute)
        sinon.assert.calledTwice(renderRoute)

        for (let i = 0; i < 4096; i++) normalize('/eviction-' + i)
        const parsed = parseRoute.callCount
        const rendered = renderRoute.callCount
        assert.equal(normalize(route, '/optional'), '/optional')
        assert.equal(normalize(route, '/optional/42'), '/optional/{id}')
        assert.equal(parseRoute.callCount, parsed + 1)
        assert.equal(renderRoute.callCount, rendered + 2)
      })
    }
  })
}
