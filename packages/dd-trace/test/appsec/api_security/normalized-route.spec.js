'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const {
  normalizeRouteExpress,
  tryRender,
  expandBraces,
  renderRoute,
  parseSegment,
  resolveNames,
  matchBrace,
  countStaticOnlyGroups,
  hasMarker,
  anyParamPresent,
  isPresent,
  encodeStatic,
  encodeParamName,
  urlPathOf,
  countUrlSegments,
  countRenderedSegments,
} = require('../../../src/appsec/api_security/normalized-route')

describe('normalized-route renderer', () => {
  describe('invalid / unsupported input', () => {
    it('returns null for non-string', () => {
      assert.equal(normalizeRouteExpress(null, {}), null)
      assert.equal(normalizeRouteExpress(undefined, {}), null)
      assert.equal(normalizeRouteExpress(42, {}), null)
      assert.equal(normalizeRouteExpress('', {}), null)
    })

    it('returns null for stringified RegExp routes', () => {
      assert.equal(normalizeRouteExpress('(/^/users/([0-9]+)$/i)', {}), null)
    })

    it('returns null for unbalanced optional-group brace', () => {
      assert.equal(normalizeRouteExpress('/users{/:id', {}), null)
    })

    it('returns null for v8 quoted-name routes (cannot tokenize accurately)', () => {
      assert.equal(normalizeRouteExpress('/x/:"foo+bar"', { 'foo+bar': '1' }), null)
    })
  })

  describe('static routes', () => {
    it('returns "/" for the root route', () => {
      assert.equal(normalizeRouteExpress('/', {}), '/')
    })

    it('keeps a declared trailing slash', () => {
      assert.equal(normalizeRouteExpress('/users/', {}), '/users/')
    })

    it('omits a missing trailing slash', () => {
      assert.equal(normalizeRouteExpress('/users', {}), '/users')
    })

    it('passes ASCII alphanumerics, dots, dashes, tildes, underscores untouched', () => {
      assert.equal(normalizeRouteExpress('/api/v2.0/some-path', {}), '/api/v2.0/some-path')
      assert.equal(normalizeRouteExpress('/api/_foo~bar', {}), '/api/_foo~bar')
    })

    it('percent-encodes characters outside the static alphabet', () => {
      assert.equal(normalizeRouteExpress('/api/hello world', {}), '/api/hello%20world')
      assert.equal(normalizeRouteExpress('/path/foo!bar', {}), '/path/foo%21bar')
    })

    it('passes through valid percent-encoded sequences (RFC rule 3 carve-out)', () => {
      // Declared %20 must round-trip as %20, not be re-encoded as %2520.
      assert.equal(normalizeRouteExpress('/api/hello%20world', {}), '/api/hello%20world')
      // Lowercase hex digits in the declared encoding are normalised to uppercase.
      assert.equal(normalizeRouteExpress('/api/hello%2fworld', {}), '/api/hello%2Fworld')
    })

    it('collapses consecutive slashes', () => {
      assert.equal(normalizeRouteExpress('/a//b', {}), '/a/b')
    })
  })

  describe('required named params', () => {
    it('renders a single param', () => {
      assert.equal(normalizeRouteExpress('/users/:id', { id: '1' }), '/users/{id}')
    })

    it('renders multiple params in distinct segments', () => {
      assert.equal(
        normalizeRouteExpress('/users/:userId/posts/:postId', { userId: '1', postId: '2' }),
        '/users/{userId}/posts/{postId}'
      )
    })

    it('renders params even when params map is missing', () => {
      assert.equal(normalizeRouteExpress('/users/:id', null), '/users/{id}')
      assert.equal(normalizeRouteExpress('/users/:id', undefined), '/users/{id}')
    })

    it('discards inline :name(constraint)', () => {
      assert.equal(normalizeRouteExpress('/users/:id(\\d+)', { id: '5' }), '/users/{id}')
    })

    it('handles :name(constraint)? — Express 4 optional with constraint', () => {
      assert.equal(normalizeRouteExpress('/users/:id(\\d+)?', { id: '5' }), '/users/{id}')
      assert.equal(normalizeRouteExpress('/users/:id(\\d+)?', {}), '/users')
    })
  })

  describe('Express 4 :name? optional', () => {
    it('renders the param when present', () => {
      assert.equal(normalizeRouteExpress('/users/:id?', { id: '1' }), '/users/{id}')
    })

    it('drops the param and its delimiter when absent', () => {
      assert.equal(normalizeRouteExpress('/users/:id?', {}), '/users')
      assert.equal(normalizeRouteExpress('/users/:id?', null), '/users')
    })

    it('handles dot-separated optional', () => {
      assert.equal(normalizeRouteExpress('/file.:ext?', { ext: 'json' }), '/{ext}')
      assert.equal(normalizeRouteExpress('/file.:ext?', {}), '/file')
    })
  })

  describe('Express 5 {…} optional groups', () => {
    it('includes optional named group when present in params', () => {
      assert.equal(normalizeRouteExpress('/users{/:id}', { id: '42' }), '/users/{id}')
    })

    it('excludes optional named group when absent', () => {
      assert.equal(normalizeRouteExpress('/users{/:id}', {}), '/users')
    })

    it('renders nested optional groups — both present', () => {
      assert.equal(
        normalizeRouteExpress('/tree{/:branch{/:leaf}}', { branch: 'main', leaf: 'x' }),
        '/tree/{branch}/{leaf}'
      )
    })

    it('drops inner group when its param is absent', () => {
      assert.equal(
        normalizeRouteExpress('/tree{/:branch{/:leaf}}', { branch: 'main' }),
        '/tree/{branch}'
      )
    })

    it('disambiguates static-only optional via URL segment count — present', () => {
      assert.equal(normalizeRouteExpress('/posts{/draft}', {}, '/posts/draft'), '/posts/draft')
    })

    it('disambiguates static-only optional via URL segment count — absent', () => {
      assert.equal(normalizeRouteExpress('/posts{/draft}', {}, '/posts'), '/posts')
    })
  })

  describe('rule 5 — per-URL-segment composition', () => {
    it('combines two params in one segment with "+"', () => {
      assert.equal(
        normalizeRouteExpress('/photos/:id.:format', { id: '1', format: 'jpg' }),
        '/photos/{id+format}'
      )
    })

    it('renders mixed static+dynamic segment as a single atomic element', () => {
      assert.equal(normalizeRouteExpress('/users/user-:id', { id: '7' }), '/users/{id}')
    })
  })

  describe('catch-all wildcards (rule 5 exception)', () => {
    it('renders a named catch-all (Express 5 *splat)', () => {
      assert.equal(normalizeRouteExpress('/files/*splat', {}), '/files/{splat}')
    })

    it('renders an unnamed catch-all with paramN placeholder (Express 4 *)', () => {
      assert.equal(normalizeRouteExpress('/files/*', {}), '/files/{param1}')
    })
  })

  describe('duplicate names', () => {
    it('keeps the last occurrence and assigns paramN to the earlier duplicate', () => {
      assert.equal(normalizeRouteExpress('/a/:id/b/:id', { id: '5' }), '/a/{param1}/b/{id}')
    })
  })

  describe('mount-path joining (multi-fragment concatenation)', () => {
    // These mirror what the per-layer subscriber produces; the public function takes the joined
    // string, so we exercise it as one input.
    it('joins mount + sub-router + leaf', () => {
      assert.equal(
        normalizeRouteExpress('/api/v1/users/:id', { id: '1' }),
        '/api/v1/users/{id}'
      )
    })

    it('collapses duplicated mount slashes', () => {
      assert.equal(normalizeRouteExpress('/api//users', {}), '/api/users')
    })
  })
})

describe('normalized-route helpers', () => {
  describe('isPresent', () => {
    it('is true for non-empty own values', () => {
      assert.equal(isPresent({ id: '1' }, 'id'), true)
    })

    it('is false for missing/null/empty/empty-string', () => {
      assert.equal(isPresent({}, 'id'), false)
      assert.equal(isPresent({ id: null }, 'id'), false)
      assert.equal(isPresent({ id: undefined }, 'id'), false)
      assert.equal(isPresent({ id: '' }, 'id'), false)
      assert.equal(isPresent(null, 'id'), false)
      assert.equal(isPresent(undefined, 'id'), false)
    })

    it('ignores inherited keys', () => {
      const proto = { id: '1' }
      const obj = Object.create(proto)
      assert.equal(isPresent(obj, 'id'), false)
    })
  })

  describe('hasMarker', () => {
    it('detects :name and *name markers', () => {
      assert.equal(hasMarker('/users/:id'), true)
      assert.equal(hasMarker('/files/*splat'), true)
      assert.equal(hasMarker('/files/*'), true)
    })

    it('returns false for purely static text', () => {
      assert.equal(hasMarker('/api/v1/users'), false)
      assert.equal(hasMarker('/draft'), false)
      assert.equal(hasMarker(''), false)
    })
  })

  describe('anyParamPresent', () => {
    it('is true when any contained marker has a truthy param value', () => {
      assert.equal(anyParamPresent('/:id', { id: '1' }), true)
      assert.equal(anyParamPresent('/:a/:b', { b: 'x' }), true)
    })

    it('is false when none of the markers are bound', () => {
      assert.equal(anyParamPresent('/:id', {}), false)
      assert.equal(anyParamPresent('/:id', null), false)
    })

    it('is false for marker-less input', () => {
      assert.equal(anyParamPresent('/draft', { id: '1' }), false)
    })
  })

  describe('matchBrace', () => {
    it('finds the closing brace for a simple group', () => {
      assert.equal(matchBrace('{ab}', 0), 3)
    })

    it('handles nesting', () => {
      assert.equal(matchBrace('{a{b}c}', 0), 6)
    })

    it('skips escaped braces', () => {
      assert.equal(matchBrace('{a\\}b}', 0), 5)
    })

    it('returns -1 when unbalanced', () => {
      assert.equal(matchBrace('{abc', 0), -1)
      assert.equal(matchBrace('{a{b}', 0), -1)
    })
  })

  describe('countStaticOnlyGroups', () => {
    it('counts a single static-only group', () => {
      assert.equal(countStaticOnlyGroups('/posts{/draft}'), 1)
    })

    it('returns 0 for a named group', () => {
      assert.equal(countStaticOnlyGroups('/posts{/:id}'), 0)
    })

    it('counts nested groups independently', () => {
      assert.equal(countStaticOnlyGroups('/x{/a{/b}}'), 2)
    })

    it('is 0 for routes without braces', () => {
      assert.equal(countStaticOnlyGroups('/users/:id'), 0)
    })
  })

  describe('expandBraces', () => {
    it('keeps named group when its param is bound', () => {
      assert.equal(expandBraces('/users{/:id}', { id: '1' }, () => false), '/users/:id')
    })

    it('drops named group when its param is unbound', () => {
      assert.equal(expandBraces('/users{/:id}', {}, () => false), '/users')
    })

    it('honors decideStaticOnly for static-only groups', () => {
      assert.equal(expandBraces('/posts{/draft}', {}, () => true), '/posts/draft')
      assert.equal(expandBraces('/posts{/draft}', {}, () => false), '/posts')
    })

    it('honors backslash escapes for literal braces', () => {
      assert.equal(expandBraces('/a\\{b\\}c', {}, () => false), '/a{b}c')
    })

    it('returns null on unbalanced braces', () => {
      assert.equal(expandBraces('/users{/:id', {}, () => false), null)
    })

    it('expands nested groups recursively', () => {
      assert.equal(
        expandBraces('/tree{/:branch{/:leaf}}', { branch: 'm', leaf: 'x' }, () => false),
        '/tree/:branch/:leaf'
      )
      assert.equal(
        expandBraces('/tree{/:branch{/:leaf}}', { branch: 'm' }, () => false),
        '/tree/:branch'
      )
    })
  })

  describe('tryRender', () => {
    it('runs the full pipeline for a simple route', () => {
      assert.equal(tryRender('/users/:id', { id: '1' }, []), '/users/{id}')
    })

    it('strips :name(constraint)?', () => {
      assert.equal(tryRender('/users/:id(\\d+)?', { id: '5' }, []), '/users/{id}')
      assert.equal(tryRender('/users/:id(\\d+)?', {}, []), '/users')
    })

    it('returns null on unbalanced braces', () => {
      assert.equal(tryRender('/users{/:id', {}, []), null)
    })

    it('passes decisions to the brace expander', () => {
      assert.equal(tryRender('/posts{/draft}', {}, [true]), '/posts/draft')
      assert.equal(tryRender('/posts{/draft}', {}, [false]), '/posts')
    })
  })

  describe('parseSegment', () => {
    it('handles a purely static segment', () => {
      assert.deepStrictEqual(parseSegment('users'), {
        staticText: 'users', dynamics: [], catchAll: false,
      })
    })

    it('handles a single param', () => {
      assert.deepStrictEqual(parseSegment(':id'), {
        staticText: '', dynamics: [{ name: 'id' }], catchAll: false,
      })
    })

    it('handles mixed static and param', () => {
      assert.deepStrictEqual(parseSegment('user-:id'), {
        staticText: 'user-', dynamics: [{ name: 'id' }], catchAll: false,
      })
    })

    it('handles two params separated by static (rule 5 combined)', () => {
      assert.deepStrictEqual(parseSegment(':id.:format'), {
        staticText: '.', dynamics: [{ name: 'id' }, { name: 'format' }], catchAll: false,
      })
    })

    it('recognises v8 named catch-all', () => {
      assert.deepStrictEqual(parseSegment('*splat'), {
        staticText: '', dynamics: [{ name: 'splat' }], catchAll: true,
      })
    })

    it('recognises v4 unnamed catch-all', () => {
      assert.deepStrictEqual(parseSegment('*'), {
        staticText: '', dynamics: [{ name: null }], catchAll: true,
      })
    })

    it('recognises :name* / :name+ v4 wildcard modifiers', () => {
      assert.deepStrictEqual(parseSegment(':path*'), {
        staticText: '', dynamics: [{ name: 'path' }], catchAll: true,
      })
      assert.deepStrictEqual(parseSegment(':path+'), {
        staticText: '', dynamics: [{ name: 'path' }], catchAll: true,
      })
    })
  })

  describe('resolveNames', () => {
    it('keeps a unique framework name as-is', () => {
      assert.deepStrictEqual(resolveNames([{ name: 'id' }]), ['id'])
    })

    it('replaces a nameless wildcard with param1', () => {
      assert.deepStrictEqual(resolveNames([{ name: null }]), ['param1'])
    })

    it('keeps the LAST occurrence of a duplicated name; earlier gets paramN', () => {
      assert.deepStrictEqual(
        resolveNames([{ name: 'id' }, { name: 'id' }]),
        ['param1', 'id']
      )
    })

    it('skips paramN numbers that collide with surviving framework names', () => {
      assert.deepStrictEqual(
        resolveNames([{ name: null }, { name: 'param1' }, { name: null }]),
        ['param2', 'param1', 'param3']
      )
    })

    it('URL-encodes disallowed chars in framework names', () => {
      assert.deepStrictEqual(
        resolveNames([{ name: 'a+b' }]),
        ['a%2Bb']
      )
    })
  })

  describe('renderRoute', () => {
    it('renders root as "/"', () => {
      assert.equal(renderRoute('/'), '/')
    })

    it('preserves a declared trailing slash', () => {
      assert.equal(renderRoute('/users/'), '/users/')
    })

    it('emits {name} for a sole param segment', () => {
      assert.equal(renderRoute('/users/:id'), '/users/{id}')
    })

    it('combines multi-param segments with +', () => {
      assert.equal(renderRoute('/photos/:id.:format'), '/photos/{id+format}')
    })

    it('treats catch-all as terminal', () => {
      assert.equal(renderRoute('/files/*splat'), '/files/{splat}')
    })

    it('folds consecutive slashes', () => {
      assert.equal(renderRoute('/a//b'), '/a/b')
    })
  })

  describe('encodeStatic', () => {
    it('passes the allowed alphabet untouched', () => {
      assert.equal(encodeStatic('aZ0.-~_'), 'aZ0.-~_')
    })

    it('percent-encodes single disallowed chars', () => {
      assert.equal(encodeStatic('hello world'), 'hello%20world')
      assert.equal(encodeStatic('foo!bar'), 'foo%21bar')
    })

    it('passes through valid %XX sequences (RFC carve-out)', () => {
      assert.equal(encodeStatic('hello%20world'), 'hello%20world')
    })

    it('uppercases lowercase hex in valid %XX', () => {
      assert.equal(encodeStatic('hello%2fworld'), 'hello%2Fworld')
    })

    it('UTF-8 encodes non-ASCII codepoints', () => {
      assert.equal(encodeStatic('café'), 'caf%C3%A9')
    })
  })

  describe('encodeParamName', () => {
    it('passes ordinary identifier names', () => {
      assert.equal(encodeParamName('userId'), 'userId')
    })

    it('encodes the six disallowed characters', () => {
      assert.equal(encodeParamName('a/b'), 'a%2Fb')
      assert.equal(encodeParamName('a?b'), 'a%3Fb')
      assert.equal(encodeParamName('a#b'), 'a%23b')
      assert.equal(encodeParamName('a+b'), 'a%2Bb')
      assert.equal(encodeParamName('a{b'), 'a%7Bb')
      assert.equal(encodeParamName('a}b'), 'a%7Db')
    })
  })

  describe('urlPathOf', () => {
    it('returns originalUrl without its query', () => {
      assert.equal(urlPathOf({ originalUrl: '/a?x=1' }), '/a')
    })

    it('falls back to url when originalUrl is missing', () => {
      assert.equal(urlPathOf({ url: '/b?y=2' }), '/b')
    })

    it('returns the path as-is when no query', () => {
      assert.equal(urlPathOf({ originalUrl: '/a/b' }), '/a/b')
    })
  })

  describe('countUrlSegments', () => {
    it('counts non-empty segments', () => {
      assert.equal(countUrlSegments('/a/b'), 2)
      assert.equal(countUrlSegments('/a/b/c'), 3)
    })

    it('returns 0 for "/" and ""', () => {
      assert.equal(countUrlSegments('/'), 0)
      assert.equal(countUrlSegments(''), 0)
    })

    it('treats consecutive slashes as empty (filtered out)', () => {
      assert.equal(countUrlSegments('/a//b'), 2)
    })
  })

  describe('countRenderedSegments', () => {
    it('returns 0 for root or empty', () => {
      assert.equal(countRenderedSegments('/'), 0)
      assert.equal(countRenderedSegments(''), 0)
    })

    it('counts atomic elements', () => {
      assert.equal(countRenderedSegments('/users/{id}'), 2)
      assert.equal(countRenderedSegments('/a/b/c'), 3)
    })

    it('ignores leading/trailing slashes', () => {
      assert.equal(countRenderedSegments('/users/'), 1)
    })
  })
})
