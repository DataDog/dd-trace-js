'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { gunzipSync } = require('node:zlib')

const INPUT = {
  mediaType: 'audio/lpcm', sampleSizeBits: 16, channelCount: 1, sampleRateHertz: 16_000, encoding: 'base64',
}
const OUTPUT = { ...INPUT, sampleRateHertz: 24_000 }
const MODEL = 'amazon.nova-2-sonic-v1:0'
const EPOCH = 1_000_000

function event (name, data) {
  return { chunk: { bytes: Buffer.from(JSON.stringify({ event: { [name]: data } })) } }
}

function pcm (milliseconds, rate = 24_000, sample = 2) {
  const raw = Buffer.alloc(Math.floor(milliseconds * rate / 1000) * 2)
  for (let i = 0; i < raw.length; i += 2) raw.writeInt16LE(sample, i)
  return raw.toString('base64')
}

function record (name, data, at, outbound = false) {
  return { at, outbound, value: event(name, data) }
}

function fixture (name) {
  const capture = JSON.parse(gunzipSync(readFileSync(join(__dirname, 'fixtures', `${name}.json.gz`))))
  const records = capture.events.map(r => {
    const [name, data] = Object.entries(r.event)[0]
    if (r.audio_bytes !== undefined) data.content = Buffer.alloc(r.audio_bytes).toString('base64')
    return record(name, data, r.at_ns / 1e6, r.direction === 'outbound')
  })
  return { capture, records }
}

function speech ({ id = '1', offset = 0, at = 0, outputMs = 100, input = INPUT, output = OUTPUT } = {}) {
  return [
    record('promptStart', { promptName: 'prompt', audioOutputConfiguration: output }, at, true),
    record('contentStart', {
      contentName: `mic${id}`, role: 'USER', type: 'AUDIO', audioInputConfiguration: input,
    }, at, true),
    record('audioInput', { contentName: `mic${id}`, content: pcm(1000, 16_000, 1) }, at + 1000, true),
    record('contentEnd', { contentName: `mic${id}` }, at + 1000, true),
    record('userSpeechStart', { inputAudioOffsetMs: offset + 100, sessionId: 'provider-session' }, at + 1100),
    record('userSpeechEnd', { inputAudioOffsetMs: offset + 500, inputAudioDetectionOffsetMs: offset + 750 }, at + 2500),
    record('contentStart', { contentId: `user${id}`, role: 'USER', type: 'TEXT' }, at + 2550),
    record('textOutput', { contentId: `user${id}`, content: `question ${id}` }, at + 2551),
    record('contentEnd', { contentId: `user${id}` }, at + 2552),
    record('contentStart', {
      contentId: `audio${id}`, role: 'ASSISTANT', type: 'AUDIO', completionId: 'shared',
    }, at + 2700),
    record('audioOutput', { contentId: `audio${id}`, content: pcm(outputMs) }, at + 3000),
    record('contentEnd', { contentId: `audio${id}`, stopReason: 'END_TURN' }, at + 3050),
    record('contentStart', {
      contentId: `final${id}`, role: 'ASSISTANT', type: 'TEXT', additionalModelFields: '{"generationStage":"FINAL"}',
    }, at + 3060),
    record('textOutput', { contentId: `final${id}`, content: `answer ${id}` }, at + 3070),
    record('contentEnd', { contentId: `final${id}` }, at + 3080),
  ]
}

module.exports = { INPUT, OUTPUT, MODEL, EPOCH, event, pcm, record, fixture, speech }
