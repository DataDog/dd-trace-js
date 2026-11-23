'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const sinon = require('sinon')
// path-to-regexp is a transitive (vendored) dependency; require it directly to exercise the
// normalizer against the real Express 5 parser/matcher (path-to-regexp 8).
// eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-require
const pathToRegexp = require('path-to-regexp')

const instrumentations = require('../../../../datadog-instrumentations/src/helpers/instrumentations')
const { getParse, getMatch } = require('../../../../datadog-instrumentations/src/path-to-regexp')
const {
  normalizeRouteExpress,
  normalizeRoute,
} = require('../../../src/appsec/api_security/normalized-route')

// Install the real path-to-regexp 8 adapters, as the loader does when the host requires it.
for (const { versions, hook } of instrumentations['path-to-regexp']) {
  if (versions.includes('>=8')) hook(pathToRegexp)
}
const parse = getParse()
const makeMatcher = getMatch()

function normalize (route, params, url, options = {}) {
  return normalizeRouteExpress(route, params, url, parse, makeMatcher, [{ route, options }])
}

// Register one test per case, named after its inputs so a failure names the exact route.
function check (route, url, expected, params = {}) {
  it(`${route}${url === undefined ? '' : ` on ${url}`} → ${expected}`, () => {
    assert.equal(normalize(route, params, url), expected)
  })
}

describe('normalizeRouteExpress', () => {
  describe('unsupported inputs return null', () => {
    check(null, undefined, null)
    check('', undefined, null)
    check('/users/:"unterminated', undefined, null)
    check('/users{/:id', undefined, null)
    check('/users/:id?', undefined, null) // Express 4 syntax
    check('/files/*', undefined, null) // unnamed catch-all: a parse error in Express 5
    check('(/^\\/a$/)', '/a', null) // RegExp route

    it('returns null when no parse function is provided (Express 4 / path-to-regexp 0.x)', () => {
      assert.equal(normalizeRouteExpress('/users/:id', {}, '/users/1', undefined), null)
    })
  })

  describe('static routes and params', () => {
    check('/', '/', '/')
    check('/users', '/users', '/users')
    check('/a//b', '/a/b', '/a/b')
    check('/users/:id/posts/:postId', '/users/1/posts/2', '/users/{id}/posts/{postId}')
    check('/users/user-:id', '/users/user-5', '/users/user-{id}')
    check('/files/:name.json', '/files/report.json', '/files/{name}.json')
    check('/photos/:id.:format', '/photos/1.jpg', '/photos/{id}.{format}')
  })

  describe('param names', () => {
    check('/u/:"user-id"', '/u/1', '/u/{user_id}')
    check('/:föo', '/1', '/{f_o}')
    check('/a/:"user-id"/:user_id', '/a/1/2', '/a/{user_id_2}/{user_id}')
    check('/a/:"x-y"/:x_y/:x_y_2', '/a/1/2/3', '/a/{x_y_3}/{x_y}/{x_y_2}')
    check('/:id/:id', '/x/y', '/{id_2}/{id}')
  })

  describe('optional groups', () => {
    check('/users/:id{/:tab}', '/users/1/posts', '/users/{id}/{tab}')
    check('/users/:id{/:tab}', '/users/1', '/users/{id}')
    check('/files/:name{.:ext}', '/files/a.txt', '/files/{name}.{ext}')
    check('/files/:name{.:ext}', '/files/a', '/files/{name}')
    check('/a{/:x{/:y}}', '/a/1', '/a/{x}')
    check('/drafts{/preview}', '/drafts/preview', '/drafts/preview')
    check('/drafts{/preview}', '/drafts', '/drafts')
    check('/files{/:id}.json', '/files.json', '/files.json')
    check('/:id{/:id}', '/x/y', '/{id_2}/{id}')
  })

  describe('catch-alls', () => {
    check('/files/*path', '/files/a/b', '/files/{path}')
    check('/files/*path', '/files//', '/files/') // captured only slashes → absent
    check('/files{/*path}', '/files', '/files')
    check('/a/*mid/b', '/a/x/y/b', '/a/{mid}/b')
    check('/*id/a/*id', '/foo/a//', '/{id_2}/a/{id}') // shared name → kept present
    check('/files/*id{.:id}', '/files//', '/files/') // the sharing token is absent → not shared
    check('/siblings/*id{/:id}', '/siblings//', '/siblings/')
  })

  describe('static encoding', () => {
    check('/café', '/caf%C3%A9', '/caf%C3%A9')
    check('/caf%c3%a9', '/caf%C3%A9', '/caf%C3%A9')
    check('/100%', '/100%', '/100%25')
    check('/a\\+b/:id', '/a+b/1', '/a%2Bb/{id}')
  })

  describe('trailing slash', () => {
    check('/users/:id/', '/users/1/', '/users/{id}/')
    check('/users{/}', '/users/', '/users/')
    check('/users{/}', '/users', '/users')
  })

  describe('routing options', () => {
    const cases = [
      ['/posts{/draft}/', '/posts/draft', {}, '/posts/draft/'],
      ['/posts{/draft}/', '/posts/draft/', { strict: true }, '/posts/draft/'],
      ['/p{A}{a}', '/pa', {}, '/pA'],
      ['/p{A}{a}', '/pa', { sensitive: true }, '/pa'],
    ]
    for (const [route, url, options, expected] of cases) {
      it(`${route} on ${url} with ${JSON.stringify(options)} → ${expected}`, () => {
        assert.equal(normalize(route, {}, url, options), expected)
      })
    }
  })

  describe('mount prefix and served route matched in sequence', () => {
    // The mount matches the start of the URL, the served route the rest, each with its own options.
    function checkParts (mount, served, url, expected, params = {}) {
      it(`${mount.route} + ${served.route} on ${url} → ${expected}`, () => {
        const parts = [{ route: mount.route, options: { ...mount.options, end: false } }, { options: {}, ...served }]
        const route = mount.route + served.route
        assert.equal(normalizeRouteExpress(route, params, url, parse, makeMatcher, parts), expected)
      })
    }

    // The served route's group ids follow the mount's; mount params survive mergeParams=false.
    const versioned = { route: '/api{/v:version}' }
    const tabs = { route: '/users{/:tab}' }
    checkParts(versioned, tabs, '/api/v2/users/me', '/api/v{version}/users/{tab}')
    checkParts(versioned, tabs, '/api/users', '/api/users')
    checkParts({ route: '/orgs{/:orgId}' }, { route: '/users/:userId' }, '/orgs/acme/users/42?x=1',
      '/orgs/{orgId}/users/{userId}', { userId: '42' })
    // An empty served route ('') answers the mount root.
    checkParts({ route: '/a{/:x}' }, { route: '' }, '/a/1', '/a/{x}')
    // Each part uses its own Router's options.
    checkParts({ route: '/API' }, { route: '/p{A}{a}', options: { sensitive: true } }, '/api/pa', '/API/pa')
    checkParts({ route: '/api{/preview}{/:t}', options: { sensitive: true } }, { route: '/x' }, '/api/PREVIEW/x',
      '/api/{t}/x')
    // A part that doesn't match falls back to req.params for the whole route.
    checkParts(versioned, tabs, '/other', '/api/users/{tab}', { tab: 'me' })
  })

  describe('fallback to req.params without a URL match', () => {
    check('/api{/:version}/users', undefined, '/api/{version}/users', { version: 'v2' })
    check('/api{/:version}/users', '/other', '/api/users', { version: '' })
    check('/posts{/draft}/:id', '/other', '/posts/{id}', { id: '1' }) // static-only group removed
    check('/:id{/:id}', '/other', '/{id}', { id: 'x' }) // shared name can't be attributed
    check('/a{/b{/:c}}', '/other', '/a/b/{c}', { c: 'z' })
    check('/x{/:toString}', '/other', '/x') // inherited properties are not params
    check('/items{/:id}', '/other', '/items/{id}', { id: '/' }) // a decoded '%2F' is a value

    it('resolves a route over the optional-group cap from req.params', () => {
      const route = '/r' + Array.from({ length: 9 }, (_, i) => `{/:p${i}}`).join('')
      assert.equal(normalize(route, { p0: 'x' }, '/r/x'), '/r/{p0}')
    })

    it('stops caching rendered outputs past the per-route limit', () => {
      const route = '/c' + Array.from({ length: 7 }, (_, i) => `{/:p${i}}`).join('')
      const present = mask => [0, 1, 2, 3, 4, 5, 6].filter(i => mask & (1 << i))
      const paramsFor = mask => Object.fromEntries(present(mask).map(i => [`p${i}`, 'x']))
      const expectedFor = mask => '/c' + present(mask).map(i => `/{p${i}}`).join('')
      for (let mask = 0; mask < 70; mask++) assert.equal(normalize(route, paramsFor(mask)), expectedFor(mask))
      // Past the limit, outputs are rendered again and stay correct.
      assert.equal(normalize(route, paramsFor(69)), expectedFor(69))
      assert.equal(normalize(route, paramsFor(63)), expectedFor(63))
    })

    it('resolves from req.params when a matcher cannot be built', () => {
      const parts = [{ route: '/m{/:id}/:x', options: {} }]
      assert.equal(normalizeRouteExpress('/m{/:id}/:x', { x: '1' }, '/m/1', parse, () => undefined, parts), '/m/{x}')
    })
  })

  describe('alternative order matches path-to-regexp match()', () => {
    // The names emitted for uniquely named params must equal the keys match() captured.
    const cases = [
      ['/a{/:x}{/:y}', ['/a', '/a/1', '/a/1/2']],
      ['/:a{.:b}{-:c}', ['/x', '/x.y', '/x-z', '/x.y-z']],
      ['/files{/:id}/*rest', ['/files/x', '/files/x/y']],
      ['/a{/:b{/:c}}{/:d}', ['/a', '/a/1', '/a/1/2', '/a/1/2/3']],
    ]
    for (const [route, urls] of cases) {
      for (const url of urls) {
        it(`${route} on ${url}`, () => {
          const matcher = pathToRegexp.match(route, { decode: false })
          const { params } = matcher(url)
          const names = [...normalize(route, {}, url).matchAll(/\{(\w+)\}/g)].map(m => m[1])
          assert.deepStrictEqual(names.sort(), Object.keys(params).sort())
        })
      }
    }
  })

  describe('normalizeRoute(req) dispatcher', () => {
    // The express path is covered end-to-end by the plugin integration spec; here we only assert
    // the short-circuit when there is no active web span.
    it('returns null when there is no active web span', () => {
      assert.equal(normalizeRoute({ originalUrl: '/x', params: {} }), null)
    })

    // A process can serve both Express majors while the parser adapters are process-wide, so the
    // major is decided per request off the serving app.
    it('returns null for an Express 4 request even when a parser is available', () => {
      const span = { context: () => ({ getTag: tag => (tag === 'component' ? 'express' : '/users/:id') }) }
      const req = { originalUrl: '/users/1', params: { id: '1' }, app: { del () {} } }
      const web = require('../../../src/plugins/util/web')
      const root = sinon.stub(web, 'root').returns(span)
      try {
        assert.equal(normalizeRoute(req), null)
      } finally {
        root.restore()
      }
    })
  })
})
