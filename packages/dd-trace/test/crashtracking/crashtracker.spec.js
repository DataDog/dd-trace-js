'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')

const proxyquire = require('proxyquire')
const sinon = require('sinon')
require('../setup/core')

const describeNotWindows = os.platform() !== 'win32' ? describe : describe.skip

describeNotWindows('crashtracker', () => {
  let crashtracker
  let binding
  let config
  let libdatadog
  let log

  beforeEach(() => {
    libdatadog = require('@datadog/libdatadog')

    binding = libdatadog.load('crashtracker')

    config = {
      port: 7357,
      tags: {
        foo: 'bar',
      },
    }

    log = {
      error: sinon.stub(),
    }

    sinon.spy(binding, 'init')
    sinon.spy(binding, 'updateConfig')
    sinon.spy(binding, 'updateMetadata')

    crashtracker = proxyquire('../../src/crashtracking/crashtracker', {
      '../log': log,
    })
  })

  afterEach(() => {
    binding.init.restore()
    binding.updateConfig.restore()
    binding.updateMetadata.restore()
  })

  describe('start', () => {
    it('should initialize the binding', () => {
      crashtracker.start(config)

      sinon.assert.called(binding.init)
      sinon.assert.notCalled(log.error)
    })

    it('should initialize the binding only once', () => {
      crashtracker.start(config)
      crashtracker.start(config)

      sinon.assert.calledOnce(binding.init)
    })

    it('should reconfigure when started multiple times', () => {
      crashtracker.start(config)
      crashtracker.start(config)

      sinon.assert.called(binding.updateConfig)
      sinon.assert.called(binding.updateMetadata)
    })

    it('should handle errors', () => {
      crashtracker.start(null)

      assert.doesNotThrow(() => crashtracker.start(config))
    })

    it('should handle unix sockets', () => {
      config.url = new URL('unix:///var/datadog/apm/test.socket')

      crashtracker.start(config)

      sinon.assert.called(binding.init)
      sinon.assert.notCalled(log.error)
    })
  })

  describe('configure', () => {
    it('should reconfigure the binding when started', () => {
      crashtracker.start(config)
      crashtracker.configure(config)

      sinon.assert.called(binding.updateConfig)
      sinon.assert.called(binding.updateMetadata)
    })

    it('should reconfigure the binding only when started', () => {
      crashtracker.configure(config)

      sinon.assert.notCalled(binding.updateConfig)
      sinon.assert.notCalled(binding.updateMetadata)
    })

    it('should handle errors', () => {
      crashtracker.start(config)
      crashtracker.configure(null)

      assert.doesNotThrow(() => crashtracker.configure(config))
    })
  })

  describe('process tags', () => {
    it('should include process tags in metadata', () => {
      crashtracker.start(config)

      sinon.assert.calledOnce(binding.init)
      const metadata = binding.init.firstCall.args[2]

      assert.ok(metadata)
      assert.ok(Array.isArray(metadata.tags))

      // Check that process tags are included
      const hasEntrypointType = metadata.tags.some(tag => tag.startsWith('entrypoint.type:'))
      const hasEntrypointName = metadata.tags.some(tag => tag.startsWith('entrypoint.name:'))
      const hasEntrypointWorkdir = metadata.tags.some(tag => tag.startsWith('entrypoint.workdir:'))
      const hasEntrypointBasedir = metadata.tags.some(tag => tag.startsWith('entrypoint.basedir:'))

      assert.ok(hasEntrypointType, 'should include entrypoint.type tag')
      assert.ok(hasEntrypointName, 'should include entrypoint.name tag')
      assert.ok(hasEntrypointWorkdir, 'should include entrypoint.workdir tag')
      assert.ok(hasEntrypointBasedir, 'should include entrypoint.basedir tag')
    })

    it('should include user tags and process tags together', () => {
      crashtracker.start(config)

      const metadata = binding.init.firstCall.args[2]

      // Check that user tags are included
      const hasFooTag = metadata.tags.some(tag => tag === 'foo:bar')
      assert.ok(hasFooTag, 'should include user-defined tags')

      // Check that process tags are also included
      const hasProcessTags = metadata.tags.some(tag => tag.startsWith('entrypoint.'))
      assert.ok(hasProcessTags, 'should include process tags')
    })

    it('should update process tags when reconfiguring', () => {
      crashtracker.start(config)
      crashtracker.configure(config)

      sinon.assert.called(binding.updateMetadata)
      const metadata = binding.updateMetadata.firstCall.args[0]

      assert.ok(metadata)
      assert.ok(Array.isArray(metadata.tags))

      // Verify process tags are in the updated metadata
      const hasProcessTags = metadata.tags.some(tag => tag.startsWith('entrypoint.'))
      assert.ok(hasProcessTags, 'should include process tags in updated metadata')
    })
  })
})
