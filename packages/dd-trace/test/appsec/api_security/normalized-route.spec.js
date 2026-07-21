'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
// path-to-regexp is a transitive (vendored) dependency, not a declared one; requiring it directly
// lets these unit tests exercise the normalizer against the real Express 5 (v8) parser/matcher.
// eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-require
const { parse: rawParse, match: rawMatch } = require('path-to-regexp')
const {
  normalizeRouteExpress,
  normalizeRoute,
} = require('../../../src/appsec/api_security/normalized-route')

// Mirror the getParse instrumentation adapter: v8 TokenData ({ tokens }) or undefined.
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
    matcher = rawMatch(route)
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
    check(undefined, undefined, null)
    check('', undefined, null)
    check(42, undefined, null)
    check('/users/:"unterminated', undefined, null) // parser throws
    check('/users{/:id', undefined, null) // unbalanced group brace, parser throws
    check('/path(\\.ext)?', undefined, null) // standalone parentheses, parser throws

    it('returns null when no parse function is provided (Express 4 / path-to-regexp 0.x)', () => {
      assert.equal(normalizeRouteExpress('/users/:id', {}, '/users/1', undefined), null)
    })
  })

  describe('Express 4 syntax is unsupported (parser throws → null)', () => {
    // path-to-regexp v8 (Express 5) rejects the Express 4 grammar. A real Express 5 app cannot
    // register these routes, so omitting the tag is correct.
    check('/users/:id?', undefined, null) // optional-suffix param
    check('/users/:id(\\d+)', undefined, null, { id: '5' }) // inline regex constraint
    check('/files/*', undefined, null) // unnamed wildcard
    check('/files/:path*', undefined, null) // :name* modifier
    check('/files/:path+', undefined, null) // :name+ modifier
    check('/api/v:major?/users', undefined, null) // static-prefixed optional param
  })

  describe('root and trivial routes', () => {
    check('/', undefined, '/')
    check('/users/', undefined, '/users/') // trailing slash preserved when declared
    check('/users', undefined, '/users')
    check('/a//b', '/a/b', '/a/b') // consecutive-slash empty segment collapsed (rule 2)
  })

  describe('static routes', () => {
    check('/api/v1/users', undefined, '/api/v1/users')
    check('/api/v2.0/some-path', undefined, '/api/v2.0/some-path') // dots and dashes kept
    check('/api/hello world', undefined, '/api/hello%20world')
    check('/path/foo@bar', undefined, '/path/foo%40bar')
  })

  describe('required named params', () => {
    check('/users/:id', undefined, '/users/{id}', { id: '123' })
    check('/users/:userId/posts/:postId', undefined, '/users/{userId}/posts/{postId}',
      { userId: '1', postId: '2' })
    check('/api/v1/users/:id', undefined, '/api/v1/users/{id}', { id: '42' })
    check('/users/:id', undefined, '/users/{id}', null) // params null → required params still included
    check('/:$foo', '/x', '/{$foo}', { $foo: 'x' }) // $ allowed in param names
    check('/:café', '/x', '/{café}', { café: 'x' }) // Unicode allowed in param names
  })

  describe('multi-param segments (rule 5)', () => {
    check('/photos/:id.:format', undefined, '/photos/{id+format}', { id: '1', format: 'jpg' })
    check('/v/:major.:minor.:patch', undefined, '/v/{major+minor+patch}',
      { major: '1', minor: '2', patch: '3' })
    check('/users/user-:id', undefined, '/users/{id}', { id: '5' }) // static text around one param dropped
  })

  describe('Express 5 named wildcard (*name)', () => {
    check('/*splat', undefined, '/{splat}', { splat: 'anything' })
    check('/files/*rest', undefined, '/files/{rest}', { rest: 'a/b/c' })
    check('/:param1/:param2/*', undefined, null, { param1: 'x', param2: 'y' }) // unnamed * throws
    check('/:param1/:param2/*rest', undefined, '/{param1}/{param2}/{rest}',
      { param1: 'x', param2: 'y', rest: 'z' }) // paramN collision avoided
  })

  describe('non-terminal catch-all (returns null)', () => {
    check('/*splat/edit', undefined, null)
    check('/x{/*rest}/tail', '/x/a/tail', null)
  })

  describe('wildcard with a prefix in its segment', () => {
    check('/files/v*rest', '/files/vY/z', '/files/{rest}') // no optional groups → precomputed
    check('/x/:a-*rest', '/x/y-z/w', '/x/{a+rest}')
    check('/files{/:opt}/v*rest', '/files/x/vY/z', '/files/{opt}/{rest}') // alongside an optional group
    check('/files{/:opt}/v*rest', '/files/vY/z', '/files/{rest}')
  })

  describe('mount-prefixed routes and combined cases', () => {
    check('/app/users/:id', undefined, '/app/users/{id}', { id: '5' })
    check('/api/:version/*path', undefined, '/api/{version}/{path}', { version: 'v2', path: 'a/b' })
    check('/users/:id/', undefined, '/users/{id}/', { id: '1' }) // trailing slash with params
  })

  describe('Express 5 {/:param} optional-group syntax', () => {
    check('/items{/:id}', '/items/42', '/items/{id}')
    check('/items{/:id}', '/items', '/items')
    check('/items{/:id}', undefined, '/items/{id}', { id: '42' }) // resolved from req.params
    check('/api{/:version}/users', '/api/v1/users', '/api/{version}/users') // middle optional segment
    check('/api{/:version}/users', '/api/users', '/api/users')
    check('/posts{/:id.:format}', '/posts/1.json', '/posts/{id+format}') // multi-param optional segment
    check('/posts{/:id.:format}', '/posts', '/posts')
    check('/files{/*path}', '/files/a/b', '/files/{path}') // optional catch-all
    check('/files{/*path}', '/files', '/files')
    check('/users{/:"user-id"}', '/users/42', '/users/{user-id}') // quoted name, hyphen allowed
    check('/users{/:"user-id"}', '/users', '/users')
    check('/a{/:b{/:c}}', '/a/x/y', '/a/{b}/{c}') // nested optional groups
    check('/a{/:b{/:c}}', '/a/x', '/a/{b}')
    check('/a{/:b{/:c}}', '/a', '/a')
  })

  describe('intra-segment / multi-segment optional param groups (resolved via match)', () => {
    check('/photos/:id{.:format}', '/photos/1.jpg', '/photos/{id+format}')
    check('/photos/:id{.:format}', '/photos/1', '/photos/{id}')
    check('/:a{.:b}{-:c}', '/x.y-z', '/{a+b+c}') // two independent optional groups
    check('/:a{.:b}{-:c}', '/x-z', '/{a+c}')
    check('/:a{.:b}{-:c}', '/x', '/{a}')
    check('/:a{.:b}-*rest', '/x.y-/def', '/{a+b+rest}') // optional group before a wildcard
    check('/:a{.:b}-*rest', '/x-/def', '/{a+rest}')
    check('/x{/:a/:b}', '/x/1/2', '/x/{a}/{b}') // group spanning >1 URL segment
    check('/x{/:a/:b}', '/x', '/x')
    check('{/:a}{/:b/:c}', '/B/C', '/{b}/{c}') // adjacent optional groups, no static prefix
    check('{/:a}{/:b/:c}', '/A/B/C', '/{a}/{b}/{c}')
  })

  describe('omitted shapes (returns null, not a wrong tag)', () => {
    // A static-only optional group has no capture key, so match() cannot report whether it was
    // present in the request; a duplicate param name collapses to one key and is equally ambiguous.
    check('/posts{/draft}', '/posts/draft', null) // static-only optional group
    check('/foo{bar}', '/foobar', null)
    check('/foo{bar}baz', '/foobaz', null)
    check('/a{b}{c}', '/abc', null)
    check('/a{{/b}}', '/a/b', null)
    check('/a{/:id}/p{q}*rest', '/a/1/pZ/w', null) // param group mixed with a static-only sibling
    check('/:id{/:id}', '/x', null, { id: 'x' }) // optional group shares a param name
    check('/a{/:x}/b{/:x}', '/a/b/v', null, { x: 'v' })
    check('/files/*path.:ext', '/files/a/b.txt', null) // non-terminal catch-all (suffix tokens)
    check('/*a-*b', '/x-y', null)
    check('/users{/}', '/users/', null) // optional trailing/interior slash group
    check('/items{/:id/}', '/items/42/', null)
  })

  describe('URL-based optional resolution (mergeParams=false fix)', () => {
    // The request URL — not req.params — drives presence, so sub-routers mounted without
    // mergeParams (where req.params drops the parent's optional param) still resolve correctly.
    check('/api{/:version}/users', undefined, '/api/users') // no URL, empty params → absent
    check('/api{/:version}/users', '/completely/different/path', '/api/{version}/users',
      { version: 'v2' }) // URL doesn't match → fall back to params
    check('/a{/:x}{/:y}/b', '/a/1/2/b', '/a/{x}/{y}/b')
    check('/a{/:x}{/:y}/b', '/a/1/b', '/a/{x}/b')
    check('/a{/:x}{/:y}/b', '/a/b', '/a/b')
    check('/api{/:version}/users{/:id}', '/api/v1/users/42', '/api/{version}/users/{id}',
      { id: '42' }) // URL authoritative: recovers a mergeParams-dropped parent optional
    check('/files{/:id}/*rest', '/files/x/y/z', '/files/{id}/{rest}') // greedy: optional fills first
    // Required '*rest' needs >=1 segment, so '/files/x' assigns rest=x and id is absent — it must
    // not shift x into {/:id} and let the wildcard match zero segments.
    check('/files{/:id}/*rest', '/files/x', '/files/{rest}')
  })

  describe('static segment encoding (UTF-8 correctness)', () => {
    check('/path/café', undefined, '/path/caf%C3%A9') // multi-byte UTF-8, not Latin-1 %E9
    check('/a/b c', undefined, '/a/b%20c')
    check('/a/b,c', undefined, '/a/b%2Cc')
    check('/path/🚀', undefined, '/path/%F0%9F%9A%80') // 4-byte emoji, not two U+FFFD surrogates
    check('/file/\\{id\\}', '/file/{id}', '/file/%7Bid%7D') // backslash-escaped reserved chars → static
  })

  describe('prototype property safety (:toString, :constructor)', () => {
    check('/x{/:toString}', undefined, '/x') // inherited prop, not own → absent
    check('/x{/:constructor}', undefined, '/x')
    check('/x{/:toString}', undefined, '/x/{toString}', { toString: 'val' }) // own prop → present
  })

  describe('duplicate param names (shadowed occurrences become paramN)', () => {
    // Express keeps only the last value for a duplicated name, so earlier occurrences have no
    // retrievable name and are numbered paramN in declaration order (RFC rule 4).
    check('/:id/:id', '/x/y', '/{param1}/{id}')
    check('/:id/:id/:id', '/x/y/z', '/{param1}/{param2}/{id}')
    check('/:param1/:param1', '/x/y', '/{param2}/{param1}') // paramN skips a surviving framework name
    check('/:"a/b"/:"a%2Fb"', '/x/y', '/{param1}/{a%2Fb}') // uniqueness enforced on encoded names
    check('/:"a\\"b"', '/x', '/{a"b}', { 'a"b': 'x' }) // escaped quote in name; " allowed per rule 4
  })

  describe('performance / safety guards', () => {
    it('returns null when a route has too many optional groups (bitmask guard)', () => {
      const route = '/r' + Array.from({ length: 33 }, (_, i) => `{/s${i + 1}}`).join('')
      assert.equal(normalize(route, {}, '/r/s33'), null)
    })

    it('does not throw when the matcher regexp is too large to compile (params fallback)', () => {
      const route = '/' + Array.from({ length: 12 }, (_, i) => `{/:p${i}}`).join('') + '/zzz'
      const url = '/' + Array.from({ length: 12 }, () => 'x').join('/') + '/nomatch'
      const result = normalize(route, {}, url)
      assert.ok(result === null || typeof result === 'string')
    })
  })

  describe('normalizeRoute(req) dispatcher', () => {
    // The dispatcher reads the component/route via the web module; the express path is covered
    // end-to-end by the express plugin integration spec. Here we assert the short-circuit when
    // there is no active web span (web.root(req) is undefined → component undefined → null).
    it('returns null when there is no active web span', () => {
      assert.equal(normalizeRoute({ originalUrl: '/x', params: {} }), null)
    })
  })
})
