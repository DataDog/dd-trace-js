'use strict'

const {
  PEER_SERVICE_KEY,
  PEER_SERVICE_REMAP_KEY,
  PEER_SERVICE_SOURCE_KEY,
} = require('../../constants')

const COMMON_PEER_SERVICE_SOURCE_TAGS = [
  'net.peer.name',
  'out.host',
]

/**
 * Resolve peer-service tags from the configured integration precursors and common outbound tags.
 *
 * @param {Record<string, string>} tags
 * @param {string[]} precursors
 * @returns {Record<string, string> | undefined}
 */
function getPeerService (tags, precursors) {
  if (tags[PEER_SERVICE_KEY] !== undefined) {
    return {
      [PEER_SERVICE_KEY]: tags[PEER_SERVICE_KEY],
      [PEER_SERVICE_SOURCE_KEY]: PEER_SERVICE_KEY,
    }
  }

  for (const sourceTag of precursors) {
    if (tags[sourceTag]) {
      return {
        [PEER_SERVICE_KEY]: tags[sourceTag],
        [PEER_SERVICE_SOURCE_KEY]: sourceTag,
      }
    }
  }

  for (const sourceTag of COMMON_PEER_SERVICE_SOURCE_TAGS) {
    if (tags[sourceTag]) {
      return {
        [PEER_SERVICE_KEY]: tags[sourceTag],
        [PEER_SERVICE_SOURCE_KEY]: sourceTag,
      }
    }
  }
}

/**
 * Apply the configured peer-service remapping to resolved peer data.
 *
 * @param {Record<string, string>} peerData
 * @param {Record<string, string> | undefined} mapping
 * @returns {Record<string, string>}
 */
function remapPeerService (peerData, mapping) {
  const peerService = peerData[PEER_SERVICE_KEY]
  const mappedService = mapping?.[peerService]
  if (!peerService || !mappedService) return peerData

  return {
    ...peerData,
    [PEER_SERVICE_KEY]: mappedService,
    [PEER_SERVICE_REMAP_KEY]: peerService,
  }
}

module.exports = { getPeerService, remapPeerService }
