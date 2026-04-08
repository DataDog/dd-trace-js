'use strict'

const {
  Function: PprofFunction,
  Label,
  Line,
  Location,
  Profile,
  Sample,
  StringTable,
  ValueType,
} = require('../../../../../../vendor/dist/pprof-format')

const MS_TO_NS = 1_000_000
const END_TIMESTAMP_LABEL = 'end_timestamp_ns'
const SAMPLE_KIND_LABEL = 'sample_kind'
const SAMPLE_KIND_STACK = 'stack'
// sample <-> unique call stack ==> [allocObjects, allocSpace, liveObjects, liveSpace]
// used for flamegraph similar to heap profiler but precise values

const SAMPLE_KIND_TIMELINE = 'timeline'
// sample <-> ~50ms tick ==> [cumulativeAllocCount, cumulativeAllocSize, liveCount, liveSize]
// used for timeline

/**
 * Build synthetic timeline samples from interval data.
 *
 * Each interval becomes a single pprof sample with a synthetic single-frame
 * location (empty function name, following the events profiler pattern) and
 * labels for `sample_kind=timeline` and `end_timestamp_ns`.
 *
 * Values per sample:
 *   - alloc_objects / alloc_space: cumulative allocated objects/bytes up to this interval
 *   - objects / space: per-interval live snapshot from heapStatsUpdate
 *
 * @param {StringTable} stringTable - Shared string table
 * @param {Location[]} locations - Shared locations array (synthetic location appended)
 * @param {PprofFunction[]} functions - Shared functions array (synthetic function appended)
 * @param {Array<{
 *   timestamp: number,
 *   liveCount?: number,
 *   liveSize?: number,
 *   allocCount?: number,
 *   allocSize?: number
 * }>} intervals
 * @returns {Sample[]} Timeline samples
 */
function buildTimelineSamples (stringTable, locations, functions, intervals) {
  if (intervals.length === 0) return []

  // Create synthetic single-frame location (events profiler pattern)
  const fn = new PprofFunction({
    id: functions.length + 1,
    name: stringTable.dedup(''),
    systemName: stringTable.dedup(''),
    filename: stringTable.dedup(''),
  })
  functions.push(fn)
  const line = new Line({ functionId: fn.id })
  const location = new Location({ id: locations.length + 1, line: [line] })
  locations.push(location)
  const syntheticLocationId = [location.id]

  const sampleKindKey = stringTable.dedup(SAMPLE_KIND_LABEL)
  const sampleKindVal = stringTable.dedup(SAMPLE_KIND_TIMELINE)
  const timestampKey = stringTable.dedup(END_TIMESTAMP_LABEL)

  const samples = []
  for (const interval of intervals) {
    const label = [
      new Label({ key: sampleKindKey, str: sampleKindVal }),
      new Label({ key: timestampKey, num: BigInt(Math.round(interval.timestamp * MS_TO_NS)) }),
    ]

    samples.push(new Sample({
      locationId: syntheticLocationId,
      value: [
        interval.allocCount || 0,
        interval.allocSize || 0,
        interval.liveCount || 0,
        interval.liveSize || 0,
      ],
      label,
    }))
  }
  return samples
}

/**
 * Build a pprof Profile from parsed allocation data with 4 value types:
 *   alloc_objects, alloc_space (total allocated), objects, space (still alive).
 *
 * Contains two sample families distinguished by the `sample_kind` label:
 *   - `stack`: real call-stack samples from the heap snapshot
 *   - `timeline`: synthetic single-frame samples per interval
 *
 * @param {Array<{stack: Array<{name: string, scriptName: string, line: number, column: number}>,
 *   allocObjects: number, allocSpace: number, liveObjects: number, liveSpace: number}>} allocations
 * @param {Date} startDate - Profile start time
 * @param {Date} endDate - Profile end time
 * @param {Array<{
 *   timestamp: number,
 *   liveCount?: number,
 *   liveSize?: number,
 *   allocCount?: number,
 *   allocSize?: number
 * }>} intervals
 * @returns {Profile} pprof Profile object
 */
function buildPprofProfile (allocations, startDate, endDate, intervals) {
  const stringTable = new StringTable()
  const locations = []
  const functions = []
  const samples = []
  const locationMap = new Map()

  const allocObjectsType = new ValueType({
    type: stringTable.dedup('alloc_objects'),
    unit: stringTable.dedup('count'),
  })
  const allocSpaceType = new ValueType({
    type: stringTable.dedup('alloc_space'),
    unit: stringTable.dedup('bytes'),
  })
  const objectsType = new ValueType({
    type: stringTable.dedup('objects'),
    unit: stringTable.dedup('count'),
  })
  const spaceType = new ValueType({
    type: stringTable.dedup('space'),
    unit: stringTable.dedup('bytes'),
  })

  const sampleKindKey = stringTable.dedup(SAMPLE_KIND_LABEL)
  const sampleKindStackVal = stringTable.dedup(SAMPLE_KIND_STACK)

  for (const entry of allocations) {
    const { stack, allocObjects, allocSpace, liveObjects, liveSpace } = entry
    if (stack.length === 0) continue
    if (allocObjects === 0 && liveObjects === 0) continue

    const locationIds = []
    for (const frame of stack) {
      const frameKey = `${frame.scriptName}:${frame.name}:${frame.line}`
      let locationId = locationMap.get(frameKey)
      if (locationId === undefined) {
        const fn = new PprofFunction({
          id: functions.length + 1,
          name: stringTable.dedup(frame.name),
          systemName: stringTable.dedup(frame.name),
          filename: stringTable.dedup(frame.scriptName),
        })
        functions.push(fn)
        const line = new Line({ functionId: fn.id, line: frame.line })
        const location = new Location({ id: locations.length + 1, line: [line] })
        locations.push(location)
        locationId = location.id
        locationMap.set(frameKey, locationId)
      }
      locationIds.push(locationId)
    }

    samples.push(new Sample({
      locationId: locationIds,
      value: [allocObjects, allocSpace, liveObjects, liveSpace],
      label: [new Label({ key: sampleKindKey, str: sampleKindStackVal })],
    }))
  }

  // Build timeline samples and merge into the same profile
  const timelineSamples = buildTimelineSamples(
    stringTable, locations, functions, intervals
  )
  for (const s of timelineSamples) {
    samples.push(s)
  }

  return new Profile({
    sampleType: [allocObjectsType, allocSpaceType, objectsType, spaceType],
    defaultSampleType: stringTable.dedup('space'),
    timeNanos: endDate.getTime() * 1_000_000,
    durationNanos: (endDate.getTime() - startDate.getTime()) * 1_000_000,
    periodType: spaceType,
    period: 1,
    sample: samples,
    location: locations,
    function: functions,
    stringTable,
  })
}

module.exports = { buildPprofProfile }
