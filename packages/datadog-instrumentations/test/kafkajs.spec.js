'use strict'

const { expect } = require('chai')
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')
const { getKafkaClusterId } = require('../src/kafkajs')

describe('kafkajs instrumentation helpers', () => {
  afterEach(() => {
    sinon.restore()
  })

  function createAdmin (overrides = {}) {
    return {
      connect: sinon.stub().resolves(),
      describeCluster: sinon.stub().resolves({ clusterId: 'cluster-a' }),
      disconnect: sinon.stub().resolves(),
      ...overrides
    }
  }

  it('returns cached cluster id when already resolved', () => {
    const kafka = { _ddKafkaClusterId: 'cached-id' }

    expect(getKafkaClusterId(kafka)).to.equal('cached-id')
  })

  it('returns null when admin interface is missing', () => {
    const kafka = {}

    expect(getKafkaClusterId(kafka)).to.equal(null)
  })

  it('returns null when describeCluster is unavailable', () => {
    const kafka = {
      admin: () => ({})
    }

    expect(getKafkaClusterId(kafka)).to.equal(null)
  })

  it('fetches and caches the cluster id when available', async () => {
    const admin = createAdmin()
    const kafka = {
      admin: () => admin
    }

    const clusterId = await getKafkaClusterId(kafka)

    expect(clusterId).to.equal('cluster-a')
    expect(kafka._ddKafkaClusterId).to.equal('cluster-a')
    sinon.assert.calledOnce(admin.connect)
    sinon.assert.calledOnce(admin.describeCluster)
    sinon.assert.calledOnce(admin.disconnect)
  })

  it('logs a warning and resolves null when cluster lookup fails', async () => {
    const error = new Error('no describe permission')
    const admin = createAdmin({
      describeCluster: sinon.stub().rejects(error)
    })
    const warnStub = sinon.stub(log, 'warn')
    const kafka = {
      admin: () => admin
    }

    const clusterId = await getKafkaClusterId(kafka)

    expect(clusterId).to.equal(null)
    sinon.assert.calledOnce(warnStub)
    sinon.assert.calledWithMatch(warnStub, 'Failed to retrieve Kafka cluster id')
    sinon.assert.calledOnce(admin.disconnect)
  })

  it('resolves null when connect throws synchronously', async () => {
    const admin = createAdmin({
      connect: sinon.stub().throws(new Error('boom'))
    })
    const warnStub = sinon.stub(log, 'warn')
    const kafka = {
      admin: () => admin
    }

    const clusterId = await getKafkaClusterId(kafka)

    expect(clusterId).to.equal(null)
    sinon.assert.calledOnce(warnStub)
    sinon.assert.calledOnce(admin.disconnect)
  })
})