const path = require('path')
const proxyquire = require('proxyquire')
const fs = require('fs')
const { getSourcePathAndLineFromSourceMaps } = require('../../../../src/appsec/iast/source-map')
const sourceMapResourcesPath = path.join(__dirname, 'source-map-test-resources')

describe('getFilenameFromSourceMap', () => {
  it('should return original object if file does not exist', () => {
    const originalPathAndLine = {
      path: path.join(sourceMapResourcesPath, 'does-not-exist.js'),
      line: 12
    }
    const pathAndLine = getSourcePathAndLineFromSourceMaps(originalPathAndLine.path, originalPathAndLine.line, 0)
    expect(pathAndLine.path).to.be.equals(originalPathAndLine.path)
    expect(pathAndLine.line).to.be.equals(originalPathAndLine.line)
  })

  it('should translate with map file', () => {
    const originalPathAndLine = {
      path: path.join(sourceMapResourcesPath, 'test-file.js'),
      line: 5
    }
    const pathAndLine = getSourcePathAndLineFromSourceMaps(originalPathAndLine.path, originalPathAndLine.line, 12)
    expect(pathAndLine.path).to.be.equals(path.join(sourceMapResourcesPath, 'test-file.ts'))
    expect(pathAndLine.line).to.be.equals(2)
  })

  it('should translate with inlined map', () => {
    const originalPathAndLine = {
      path: path.join(sourceMapResourcesPath, 'test-inline.js'),
      line: 5
    }
    const pathAndLine = getSourcePathAndLineFromSourceMaps(originalPathAndLine.path, originalPathAndLine.line)
    expect(pathAndLine.path).to.be.equals(path.join(sourceMapResourcesPath, 'test-inline.ts'))
    expect(pathAndLine.line).to.be.equals(2)
  })

  it('should translate minified file with correct column', () => {
    const originalPathAndLine = {
      path: path.join(sourceMapResourcesPath, 'test-min.min.js'),
      line: 1
    }
    const pathAndLine = getSourcePathAndLineFromSourceMaps(originalPathAndLine.path, originalPathAndLine.line, 23)
    expect(pathAndLine.path).to.be.equals(path.join(sourceMapResourcesPath, 'test-min.js'))
    expect(pathAndLine.line).to.be.equals(2)
  })
})

describe('getFilenameFromSourceMap cache', () => {
  const nodeSourceMap = require('../../../../src/appsec/iast/source-map/node_source_map')
  afterEach(() => {
    sinon.restore()
  })

  it('should not create two SourceMap file for the same file', () => {
    // const OriginalSourceMap = nodeSourceMap.SourceMap
    const sourceMapSpy = sinon.spy(nodeSourceMap, 'SourceMap')
    const { getSourcePathAndLineFromSourceMaps } = proxyquire('../../../../src/appsec/iast/source-map', {
      './node_source_map': nodeSourceMap
    })

    // nodeSourceMap.SourceMap = sinon.stub(() => sinon.createStubInstance(OriginalSourceMap))
    // const sourceMapSpy = sinon.spy(nodeSourceMap.SourceMap.prototype, 'constructor')
    const originalPathAndLine = {
      path: path.join(sourceMapResourcesPath, 'test-file.js'),
      line: 5
    }
    getSourcePathAndLineFromSourceMaps(originalPathAndLine.path, originalPathAndLine.line, 0)
    getSourcePathAndLineFromSourceMaps(originalPathAndLine.path, originalPathAndLine.line, 0)
    expect(sourceMapSpy).to.have.been.calledOnce
  })

  it('should has a maximun cached items', () => {
    const sourceMapSpy = sinon.spy(nodeSourceMap, 'SourceMap')
    const readFileSync = function (filename) {
      if (filename.indexOf('.map') > 0) {
        return fs.readFileSync(path.join(sourceMapResourcesPath, 'test-file.js.map'))
      } else if (filename.indexOf('.js') > 0) {
        return fs.readFileSync(path.join(sourceMapResourcesPath, 'test-file.js'))
      }
    }

    const { getSourcePathAndLineFromSourceMaps } = proxyquire('../../../../src/appsec/iast/source-map', {
      './node_source_map': nodeSourceMap,
      'fs': { readFileSync }
    })

    for (let i = 0; i < 101; i++) {
      getSourcePathAndLineFromSourceMaps(`/source/file-${i}.js`, 5) // new entry
      getSourcePathAndLineFromSourceMaps(`/source/file-${i}.js`, 5) // from cache
    }
    expect(sourceMapSpy).to.have.been.callCount(101)
    getSourcePathAndLineFromSourceMaps(`/source/file-0.js`, 5)
    expect(sourceMapSpy).to.have.been.callCount(102)
  })
})
