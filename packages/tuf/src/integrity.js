'use strict'

const crypto = require('crypto')
const { serialize } = require('./cjson')

function findSig (signatures, rcTargetsKeyId) {
  for (const entry of signatures) {
    if (entry.keyid === rcTargetsKeyId) {
      if (!entry.sig) break
      return entry.sig
    }
  }
  throw new Error(`missing signature for key ${rcTargetsKeyId}`)
}

function localAtob (str) {
  return Buffer.from(str, 'base64').toString('ascii')
}

function toDER (hex) {
  return Buffer.concat([
    // based on https://keygen.sh/blog/how-to-use-hexadecimal-ed25519-keys-in-node/
    // this magic number contains the OID for ed25519
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(hex, 'hex')
  ])
}

function checkIntegrity (rcTargetsKey, rcTargetsKeyId, clientGetConfigsResponse) {
  const targets = clientGetConfigsResponse.targets
  if (!targets) throw new Error('no field \'targets\' in clientGetConfigsResponse object')

  const targetFiles = clientGetConfigsResponse.target_files
  if (!targetFiles) throw new Error('no field \'target_files\' in clientGetConfigsResponse object')
  if (targetFiles.length === 0) return false

  const { signed, signatures } = JSON.parse(localAtob(targets))
  if (!signed) throw new Error('no field \'signed\' in targets object')
  if (!signatures) throw new Error('no field \'signatures\' in targets object')

  const sig = findSig(signatures, rcTargetsKeyId)
  const rawSigned = Buffer.from(serialize(signed))

  const key = crypto.createPublicKey({
    format: 'der',
    type: 'spki',
    key: toDER(rcTargetsKey)
  })

  // The algorithm is defined based on the oid
  const valid = crypto.verify(null, rawSigned, key, Buffer.from(sig, 'hex'))
  if (!valid) throw new Error(`invalid signature for key ${rcTargetsKeyId}`)

  for (let i = 0; i < targetFiles.length; ++i) {
    const configMeta = signed.targets[targetFiles[i].path]
    if (!configMeta) throw new Error(`target ${targetFiles[i].path} not found in targets`)
    const raw = localAtob(targetFiles[i].raw)
    const hash = crypto.createHash('sha256')
    const rawHash = hash.update(Buffer.from(raw)).digest('hex')
    if (raw.length !== configMeta.length || rawHash !== configMeta.hashes.sha256) {
      throw new Error(`target ${targetFiles[i].path} expected sha256 was ${configMeta.hashes.sha256}, ${rawHash} found`)
    }
  }
  return true
}

module.exports = {
  checkIntegrity
}
