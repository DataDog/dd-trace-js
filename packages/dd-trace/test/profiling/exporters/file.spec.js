'use strict'

require('../../setup/tap')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('exporters/file', () => {
  let FileExporter
  let fs

  beforeEach(() => {
    fs = {
      writeFile: sinon.stub().yields()
    }

    FileExporter = proxyquire('../../../src/profiling/exporters/file', {
      fs
    }).FileExporter
  })

  it('should export to a file per profile type', async () => {
    const exporter = new FileExporter()
    const buffer = Buffer.from('profile')
    const profiles = {
      test: buffer
    }
    await exporter.export({ profiles, end: new Date('2023-02-10T21:03:05Z') })

    sinon.assert.calledOnce(fs.writeFile)
    sinon.assert.calledWith(fs.writeFile, 'test_20230210T210305Z.pprof', buffer)
  })

  it('should export to a file per profile type with given prefix', async () => {
    const exporter = new FileExporter({ pprofPrefix: 'myprefix_' })
    const buffer = Buffer.from('profile')
    const profiles = {
      test: buffer
    }
    await exporter.export({ profiles, end: new Date('2023-02-10T21:03:05Z') })

    sinon.assert.calledOnce(fs.writeFile)
    sinon.assert.calledWith(fs.writeFile, 'myprefix_test_20230210T210305Z.pprof', buffer)
  })
})
