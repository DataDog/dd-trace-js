'use strict'

const assert = require('node:assert/strict')

const { InputAudio } = require('../packages/datadog-instrumentations/src/nova-sonic/audio')
const { LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES } = require('../packages/dd-trace/src/llmobs/constants/audio')
const benchmark = require('./benchmark')

// Run with node benchmark/nova-sonic.js on each revision being compared.
const limit = LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES - 128
const suite = benchmark('Nova Sonic input clips')
for (const [retained, bytes] of [[32_000, 32_000], [320_000, 32_000], [limit, 32_000], [limit, limit]]) {
  const audio = new InputAudio()
  audio.configure({
    mediaType: 'audio/lpcm', sampleSizeBits: 16, channelCount: 1, sampleRateHertz: 16_000, encoding: 'base64',
  })
  for (let offset = 0; offset < retained; offset += 3200) {
    audio.append(Buffer.alloc(Math.min(3200, retained - offset), 1).toString('base64'), 0)
  }
  const start = (retained - bytes) / 32
  const end = retained / 32
  let clip
  suite.add(`${bytes} bytes from ${retained} retained bytes`, {
    fn () { clip = audio.clip(start, end) },
    onComplete () { assert.deepEqual(clip, Buffer.alloc(bytes, 1)) },
  })
}
suite.run()
