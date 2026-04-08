'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const path = require('node:path')

const { describe, it } = require('mocha')

const { Profile } = require('../../../../../vendor/dist/pprof-format')

require('../../setup/core')

const helperPath = path.join(
  __dirname, 'allocation_worker_helper.js'
)

/**
 * Fork the helper script with a given command and return the
 * parsed JSON result.
 *
 * @param {string} command - Command to send to the helper
 * @returns {Promise<object>} Parsed JSON result from helper
 */
function runHelper (command) {
  return new Promise((resolve, reject) => {
    const proc = fork(helperPath, [command], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })

    let stdout = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })

    let stderr = ''
    proc.stderr.on('data', (chunk) => { stderr += chunk })

    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(
          `Helper exited with code ${code}: ${stderr}`
        ))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (e) {
        reject(new Error(
          `Failed to parse helper output: ${stdout}`
        ))
      }
    })
  })
}

describe('allocation_worker', function () {
  this.timeout(60000)

  it('sends ready after init', async () => {
    const result = await runHelper('ready')
    assert.strictEqual(result.firstMessage, 'ready')
  })

  it('sends tracking-started after start-tracking', async () => {
    const result = await runHelper('tracking-started')
    assert.strictEqual(result.message, 'tracking-started')
  })

  it('profile has 4 sample types', async () => {
    const result = await runHelper('profile')
    const profile = Profile.decode(
      Buffer.from(result.buffer, 'base64')
    )

    assert.strictEqual(profile.sampleType.length, 4)
    const typeNames = profile.sampleType.map(st => {
      const typeName = profile.stringTable.strings[st.type]
      const unitName = profile.stringTable.strings[st.unit]
      return `${typeName}/${unitName}`
    })
    assert.deepStrictEqual(typeNames, [
      'alloc_objects/count',
      'alloc_space/bytes',
      'objects/count',
      'space/bytes',
    ])
  })

  it('samples have valid locations', async () => {
    const result = await runHelper('profile')
    const profile = Profile.decode(
      Buffer.from(result.buffer, 'base64')
    )

    assert.ok(
      profile.sample.length > 0,
      'should have at least one sample'
    )

    const locationById = new Map()
    for (const loc of profile.location) {
      locationById.set(loc.id, loc)
    }
    const functionById = new Map()
    for (const fn of profile.function) {
      functionById.set(fn.id, fn)
    }

    for (const sample of profile.sample) {
      assert.strictEqual(sample.value.length, 4)
      assert.ok(sample.locationId.length >= 1)

      for (const locId of sample.locationId) {
        const loc = locationById.get(locId)
        assert.ok(loc, `location ${locId} should exist`)
        assert.ok(loc.line.length > 0)
        for (const line of loc.line) {
          const fn = functionById.get(line.functionId)
          assert.ok(fn, `function ${line.functionId} should exist`)
        }
      }
    }
  })

  it('stack samples have sample_kind=stack label and non-negative values', async () => {
    const result = await runHelper('profile')
    const profile = Profile.decode(
      Buffer.from(result.buffer, 'base64')
    )

    const stackSamples = profile.sample.filter(s =>
      s.label.some(l =>
        profile.stringTable.strings[l.key] === 'sample_kind' &&
        profile.stringTable.strings[l.str] === 'stack'
      )
    )

    assert.ok(stackSamples.length > 0, 'should have stack samples')

    let hasAllocAndInuse = false
    for (const sample of stackSamples) {
      const [aObj, aSpace, iObj, iSpace] = sample.value.map(Number)
      assert.ok(aObj >= 0, `alloc_objects (${aObj}) >= 0`)
      assert.ok(aSpace >= 0, `alloc_space (${aSpace}) >= 0`)
      assert.ok(iObj >= 0, `objects (${iObj}) >= 0`)
      assert.ok(iSpace >= 0, `space (${iSpace}) >= 0`)
      if (aObj > 0 && iObj > 0) hasAllocAndInuse = true
    }
    assert.ok(hasAllocAndInuse,
      'at least one stack sample should have both alloc and inuse')
  })

  it('timeline samples have sample_kind=timeline and end_timestamp_ns labels', async () => {
    const result = await runHelper('timeline-in-pprof')
    const profile = Profile.decode(
      Buffer.from(result.buffer, 'base64')
    )

    const timelineSamples = profile.sample.filter(s =>
      s.label.some(l =>
        profile.stringTable.strings[l.key] === 'sample_kind' &&
        profile.stringTable.strings[l.str] === 'timeline'
      )
    )

    assert.ok(timelineSamples.length > 0, 'should have timeline samples')

    for (const sample of timelineSamples) {
      // Should have end_timestamp_ns label
      const tsLabel = sample.label.find(l =>
        profile.stringTable.strings[l.key] === 'end_timestamp_ns'
      )
      assert.ok(tsLabel, 'timeline sample should have end_timestamp_ns label')
      assert.ok(Number(tsLabel.num) > 0, 'end_timestamp_ns should be positive')

      // Should have exactly one location (synthetic frame)
      assert.strictEqual(sample.locationId.length, 1, 'timeline sample should have single synthetic location')

      // Values should have 4 entries
      assert.strictEqual(sample.value.length, 4)
    }

    // Sort timeline samples by end_timestamp_ns and verify alloc_objects/alloc_space
    // are monotonically non-decreasing (cumulative running sums)
    const sorted = timelineSamples.slice().sort((a, b) => {
      const tsA = a.label.find(l => profile.stringTable.strings[l.key] === 'end_timestamp_ns')
      const tsB = b.label.find(l => profile.stringTable.strings[l.key] === 'end_timestamp_ns')
      return Number(tsA.num - tsB.num)
    })

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].value
      const curr = sorted[i].value
      assert.ok(Number(curr[0]) >= Number(prev[0]),
        `alloc_objects should be non-decreasing: ${curr[0]} >= ${prev[0]} at index ${i}`)
      assert.ok(Number(curr[1]) >= Number(prev[1]),
        `alloc_space should be non-decreasing: ${curr[1]} >= ${prev[1]} at index ${i}`)
    }
  })

  it('all samples have a sample_kind label', async () => {
    const result = await runHelper('profile')
    const profile = Profile.decode(
      Buffer.from(result.buffer, 'base64')
    )

    for (const sample of profile.sample) {
      const kindLabel = sample.label.find(l =>
        profile.stringTable.strings[l.key] === 'sample_kind'
      )
      assert.ok(kindLabel, 'every sample should have a sample_kind label')
      const kind = profile.stringTable.strings[kindLabel.str]
      assert.ok(kind === 'stack' || kind === 'timeline',
        `sample_kind should be stack or timeline, got ${kind}`)
    }
  })

  it('empty window produces valid profile', async () => {
    const result = await runHelper('empty-profile')
    const profile = Profile.decode(
      Buffer.from(result.buffer, 'base64')
    )

    assert.strictEqual(profile.sampleType.length, 4)
    assert.ok(Array.isArray(profile.sample))
  })

  it('shutdown exits cleanly', async () => {
    const result = await runHelper('shutdown')
    assert.strictEqual(result.exitCode, 0)
  })
})
