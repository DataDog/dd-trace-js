'use strict'

const { PEER_SERVICE_SOURCE_KEY } = require('../../constants')
const { storage } = require('../../../../datadog-core')
const { IS_SERVERLESS } = require('../../serverless')
const { getPeerService, remapPeerService } = require('../util/peer-service')

const addPeerService = Symbol('integration.pipeline.add_peer_service')
const peerServerlessStorage = storage('peerServerless')

/**
 * Apply the standard outbound peer-service rules to a span.
 *
 * @param {import('../../opentracing/span')} span
 * @param {import('../../config/config-base')} tracerConfig
 * @param {string[]} precursors
 * @returns {void}
 */
function tagPeerService (span, tracerConfig, precursors) {
  if (tracerConfig.spanComputePeerService) {
    const tags = span.context().getTags()
    if (tags[PEER_SERVICE_SOURCE_KEY] === undefined) {
      const peerData = getPeerService(tags, precursors)
      if (peerData) span.addTags(remapPeerService(peerData, tracerConfig.peerServiceMapping))
    }
  }

  if (IS_SERVERLESS) {
    const peerHostname = peerServerlessStorage.getStore()?.peerHostname
    if (peerHostname) span.setTag('peer.service', peerHostname)
  }
}

/**
 * Create an outbound peer-service completion stage.
 *
 * @param {{precursors?: string[]}} [options]
 * @returns {import('../integration-pipeline').PipelineStage}
 */
function createPeerServiceStage ({ precursors = [] } = {}) {
  if (!Array.isArray(precursors) || precursors.some(precursor => typeof precursor !== 'string')) {
    throw new TypeError('Peer-service stage requires a precursor list')
  }

  return {
    name: 'peer-service',
    requires: ['tracing'],
    complete (frame) {
      frame[addPeerService](tagPeerService, precursors)
    },
  }
}

module.exports = { addPeerService, createPeerServiceStage }
