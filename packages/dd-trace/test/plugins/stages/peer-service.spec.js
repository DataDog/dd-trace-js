'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { storage } = require('../../../../datadog-core')
const {
  addPeerService,
  createPeerServiceStage,
} = require('../../../src/plugins/stages/peer-service')

function getTagPeerService (stage) {
  const apply = sinon.stub()
  stage.complete({ [addPeerService]: apply })
  return apply.firstCall.args[0]
}

describe('peer-service stage', () => {
  it('declares a tracing-dependent completion hook', () => {
    const stage = createPeerServiceStage({ precursors: ['db.name'] })

    assert.strictEqual(stage.name, 'peer-service')
    assert.deepStrictEqual(stage.requires, ['tracing'])
    assert.strictEqual(stage.start, undefined)
    assert.strictEqual(typeof stage.complete, 'function')
  })

  it('passes the declared precursors to the private frame capability', () => {
    const apply = sinon.stub()
    const frame = { [addPeerService]: apply }
    const stage = createPeerServiceStage({ precursors: ['db.name', 'server.address'] })

    stage.complete(frame)

    sinon.assert.calledOnce(apply)
    assert.strictEqual(typeof apply.firstCall.args[0], 'function')
    assert.deepStrictEqual(apply.firstCall.args[1], ['db.name', 'server.address'])
  })

  it('applies peer-service precedence and remapping through the private capability implementation', () => {
    const apply = sinon.stub()
    const frame = { [addPeerService]: apply }
    const stage = createPeerServiceStage({ precursors: ['db.name'] })
    const tags = {
      'db.name': 'database',
      'out.host': 'host',
    }
    const span = {
      context: () => ({ getTags: () => tags }),
      addTags: sinon.stub(),
    }

    stage.complete(frame)
    const tagPeerService = apply.firstCall.args[0]
    tagPeerService(span, {
      spanComputePeerService: true,
      peerServiceMapping: { database: 'mapped-database' },
    }, apply.firstCall.args[1])

    sinon.assert.calledOnceWithExactly(span.addTags, {
      'peer.service': 'mapped-database',
      '_dd.peer.service.source': 'db.name',
      '_dd.peer.service.remapped_from': 'database',
    })
  })

  it('uses an explicitly set peer service before precursor tags', () => {
    const tagPeerService = getTagPeerService(createPeerServiceStage({ precursors: ['db.name'] }))
    const span = {
      context: () => ({
        getTags: () => ({
          'peer.service': 'explicit',
          'db.name': 'database',
        }),
      }),
      addTags: sinon.stub(),
    }

    tagPeerService(span, { spanComputePeerService: true }, ['db.name'])

    sinon.assert.calledOnceWithExactly(span.addTags, {
      'peer.service': 'explicit',
      '_dd.peer.service.source': 'peer.service',
    })
  })

  it('does not compute a peer service when disabled or already finalized', () => {
    const tagPeerService = getTagPeerService(createPeerServiceStage({ precursors: ['db.name'] }))
    const disabledSpan = {
      context: sinon.stub(),
      addTags: sinon.stub(),
    }
    const finalizedSpan = {
      context: () => ({
        getTags: () => ({
          'db.name': 'database',
          '_dd.peer.service.source': 'db.name',
        }),
      }),
      addTags: sinon.stub(),
    }

    tagPeerService(disabledSpan, { spanComputePeerService: false }, ['db.name'])
    tagPeerService(finalizedSpan, { spanComputePeerService: true }, ['db.name'])

    sinon.assert.notCalled(disabledSpan.context)
    sinon.assert.notCalled(disabledSpan.addTags)
    sinon.assert.notCalled(finalizedSpan.addTags)
  })

  it('uses the serverless peer hostname as the terminal peer service', () => {
    const serverlessStageModule = proxyquire('../../../src/plugins/stages/peer-service', {
      '../../serverless': { IS_SERVERLESS: true },
    })
    const apply = sinon.stub()
    const stage = serverlessStageModule.createPeerServiceStage()
    const span = {
      setTag: sinon.stub(),
    }

    stage.complete({ [serverlessStageModule.addPeerService]: apply })
    storage('peerServerless').run({ peerHostname: 'function.example.test' }, () => {
      apply.firstCall.args[0](span, { spanComputePeerService: false }, [])
    })

    sinon.assert.calledOnceWithExactly(span.setTag, 'peer.service', 'function.example.test')
  })

  it('rejects invalid precursor declarations', () => {
    assert.throws(() => createPeerServiceStage({ precursors: 'db.name' }), /requires a precursor list/)
    assert.throws(() => createPeerServiceStage({ precursors: ['db.name', 42] }), /requires a precursor list/)
  })
})
