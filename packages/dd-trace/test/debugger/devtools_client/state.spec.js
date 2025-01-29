'use strict'

require('../../setup/mocha')

describe('findScriptFromPartialPath', function () {
  let state

  before(function () {
    state = proxyquire('../src/debugger/devtools_client/state', {
      './session': {
        '@noCallThru': true,
        on (event, listener) {
          if (event === 'Debugger.scriptParsed') {
            listener({ params: { scriptId: 'script-id', url: 'file:///path/to/foo.js' } })
          }
        }
      }
    })
  })

  describe('full path matches', function () {
    it('with a "file:" protocol', testPath('file:///path/to/foo.js'))

    it('with a root slash', testPath('/path/to/foo.js'))

    it('without a root slash', testPath('path/to/foo.js'))
  })

  describe('partial path matches', function () {
    it('fewer directories', testPath('to/foo.js'))

    it('no directories', testPath('foo.js'))
  })

  describe('path contains directory prefix', function () {
    it('prefixed with unknown directory', testPath('prefix/to/foo.js'))

    it('prefixed with two unknown directories', testPath('prefix1/prefix2/to/foo.js'))
  })

  describe('circuit breakers', function () {
    it('should abort if the path is unknown', function () {
      const result = state.findScriptFromPartialPath('this/path/does/not/exist.js')
      expect(result).to.be.undefined
    })

    it('should abort if the path is undefined', function () {
      const result = state.findScriptFromPartialPath(undefined)
      expect(result).to.be.undefined
    })

    it('should abort if the path is an empty string', function () {
      const result = state.findScriptFromPartialPath('')
      expect(result).to.be.undefined
    })
  })

  function testPath (path) {
    return function () {
      const result = state.findScriptFromPartialPath(path)
      expect(result).to.deep.equal(['file:///path/to/foo.js', 'script-id', undefined])
    }
  }
})
