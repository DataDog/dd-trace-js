const toJSONTags = require('../../src/payload-tagging/tagger')
const { filterFromString } = require('../../src/payload-tagging/filter')

const globFilter = filterFromString('*')

describe('JSON payload tagger', () => {
  describe('filtering', () => {
    const input = JSON.stringify({ foo: { bar: 1, quux: 2 }, bar: 3 })
    const ctype = 'application/json'
    it('should take everything with glob filter', () => {
      const tags = toJSONTags(input, ctype, globFilter)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar': '1',
        'http.payload.foo.quux': '2',
        'http.payload.bar': '3'
      })
    })

    it('should exclude paths when excluding', () => {
      const filter = filterFromString('*,-foo.bar,-foo.quux')
      const tags = toJSONTags(input, ctype, filter)
      expect(tags).to.deep.equal({
        'http.payload.bar': '3'
      })
    })

    it('should only provide included paths when including', () => {
      const filter = filterFromString('foo.bar,foo.quux')
      const tags = toJSONTags(input, ctype, filter)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar': '1',
        'http.payload.foo.quux': '2'
      })
    })

    it('should remove an entire section if given a partial path', () => {
      const filter = filterFromString('*,-foo')
      const tags = toJSONTags(input, ctype, filter)
      expect(tags).to.deep.equal({
        'http.payload.bar': '3'
      })
    })

    it('should include an entire section if given a partial path', () => {
      const filter = filterFromString('foo')
      const tags = toJSONTags(input, ctype, filter)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar': '1',
        'http.payload.foo.quux': '2'
      })
    })
  })

  describe('tag count cutoff', () => {
    it('generate many tags when not reaching the cap', () => {
      const belowCap = 200
      const input = JSON.stringify({ foo: Object.fromEntries([...Array(belowCap).keys()].map(i => [i, i])) })
      const tagCount = Object.entries(toJSONTags(input, 'application/json', globFilter)).length
      expect(tagCount).to.equal(belowCap)
    })

    it('should stop generating tags once the cap is reached', () => {
      const aboveCap = 759
      const input = JSON.stringify({ foo: Object.fromEntries([...Array(aboveCap).keys()].map(i => [i, i])) })
      const tagCount = Object.entries(toJSONTags(input, 'application/json', globFilter)).length
      expect(tagCount).to.not.equal(aboveCap)
      expect(tagCount).to.equal(758)
    })
  })

  describe('content-type validation', () => {
    let parseSpy
    beforeEach(() => { parseSpy = sinon.spy(JSON, 'parse') })

    afterEach(() => { parseSpy.restore() })

    for (const invalidType of [null, undefined, '', 'application/yaml']) {
      it(`should not attempt parsing with invalid content-type "${invalidType}"`, () => {
        const input = JSON.stringify({ 'foo': { 'bar': { 'baz': 1, 'quux': 2 } } })
        const tags = toJSONTags(input, invalidType, globFilter)
        expect(tags).to.deep.equal({})
        expect(parseSpy).to.not.have.been.called
      })
    }

    for (const validType of [
      'application/json', 'application/foo+json', 'application/javastuff.json', 'application/legacy-json'
    ]) {
      it(`should parse with valid type ${validType}`, () => {
        const input = JSON.stringify({ 'foo': { 'bar': { 'baz': 1, 'quux': 2 } } })
        const tags = toJSONTags(input, validType, globFilter)
        expect(tags).to.not.deep.equal({})
        expect(parseSpy).to.have.been.called
      })
    }
  })

  describe('best-effort redacting of keys', () => {
    it('should redact disallowed keys', () => {
      const input = JSON.stringify({
        foo: {
          bar: {
            token: 'tokenpleaseredact',
            authorization: 'pleaseredact',
            valid: 'valid'
          },
          baz: {
            password: 'shouldgo',
            'x-authorization': 'shouldbegone',
            data: 'shouldstay'
          }
        }
      })
      const tags = toJSONTags(input, 'application/json', globFilter)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar.token': 'redacted',
        'http.payload.foo.bar.authorization': 'redacted',
        'http.payload.foo.bar.valid': 'valid',
        'http.payload.foo.baz.password': 'redacted',
        'http.payload.foo.baz.x-authorization': 'redacted',
        'http.payload.foo.baz.data': 'shouldstay'
      })
    })

    describe('escaping', () => {
      it('should escape `.` characters', () => {
        const input = JSON.stringify({ 'foo.bar': { 'baz': 'quux' } })
        const tags = toJSONTags(input, 'application/json', globFilter)
        expect(tags).to.deep.equal({
          'http.payload.foo\\.bar.baz': 'quux'
        })
      })
    })
  })

  describe('parsing', () => {
    it('should transform null values to "null" string', () => {
      const input = JSON.stringify({ 'foo': 'bar', 'baz': null })
      const tags = toJSONTags(input, 'application/json', globFilter)
      expect(tags).to.deep.equal({
        'http.payload.foo': 'bar',
        'http.payload.baz': 'null'
      })
    })

    it('should provide tags from simple JSON objects, casting to strings where necessary', () => {
      const input = JSON.stringify({
        'foo': { 'bar': { 'baz': 1, 'quux': 2 } },
        'asimplestring': 'isastring',
        'anullvalue': null
      })
      const tags = toJSONTags(input, 'application/json', globFilter)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar.baz': '1',
        'http.payload.foo.bar.quux': '2',
        'http.payload.asimplestring': 'isastring',
        'http.payload.anullvalue': 'null'
      })
    })

    it('should index tags when encountering arrays', () => {
      const input = JSON.stringify({ 'foo': { 'bar': { 'list': ['v0', 'v1', 'v2'] } } })
      const tags = toJSONTags(input, 'application/json', globFilter)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar.list.0': 'v0',
        'http.payload.foo.bar.list.1': 'v1',
        'http.payload.foo.bar.list.2': 'v2'
      })
    })

    it('should return no tags on invalid JSON string input', () => {
      const input = '{"invalid": "input"]'
      const tags = toJSONTags(input, 'application/json', globFilter)
      expect(tags).to.deep.equal({})
    })

    it('should not replace a real value at max depth', () => {
      const input = JSON.stringify({
        1: { 2: { 3: { 4: { 5: { 6: { 7: { 8: { 9: { 10: 11 } } } } } } } } }
      })
      const tags = toJSONTags(input, 'application/json', globFilter)
      expect(tags).to.deep.equal({ 'http.payload.1.2.3.4.5.6.7.8.9.10': '11' })
    })

    it('should truncate paths beyond max depth', () => {
      const input = JSON.stringify({
        1: { 2: { 3: { 4: { 5: { 6: { 7: { 8: { 9: { 10: { 11: 'too much' } } } } } } } } } }
      })
      const tags = toJSONTags(input, 'application/json', globFilter)
      expect(tags).to.deep.equal({ 'http.payload.1.2.3.4.5.6.7.8.9.10': '_dd_truncated_' })
    })
  })
})
