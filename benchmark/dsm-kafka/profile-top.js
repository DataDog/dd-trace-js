'use strict'

// Merges the per-iteration V8 CPU profiles collected by bench.js into one `.cpuprofile`
// (loadable in Chrome DevTools / VS Code) and a human-readable `<name>.top.txt` hot list.

const fs = require('node:fs')

const TOP_N = 40
const NON_WORK = new Set(['(idle)', '(program)', '(garbage collector)'])

/**
 * Each profile's root becomes a child of a new shared root, with node ids renumbered.
 *
 * @param {object[]} profiles
 * @returns {{ nodes: object[], samples: number[], timeDeltas: number[], startTime: number, endTime: number }}
 */
function merge (profiles) {
  const nodes = [{
    id: 1,
    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
    children: [],
  }]
  const samples = []
  const timeDeltas = []
  let nextId = 2

  for (const profile of profiles) {
    const idMap = new Map()
    for (const node of profile.nodes) idMap.set(node.id, nextId++)
    for (const node of profile.nodes) {
      const merged = { ...node, id: idMap.get(node.id) }
      if (node.children) merged.children = node.children.map(id => idMap.get(id))
      nodes.push(merged)
    }
    nodes[0].children.push(idMap.get(profile.nodes[0].id))
    const inspectorCalls = new Set() // nodes under session.post(): the profiler's own start/stop cost
    const byId = new Map(profile.nodes.map(node => [node.id, node]))
    const pending = profile.nodes.filter(node => isInspectorPost(node.callFrame))
    while (pending.length) {
      const node = pending.pop()
      inspectorCalls.add(node.id)
      for (const child of node.children ?? []) pending.push(byId.get(child))
    }
    for (let i = 0; i < profile.samples.length; i++) {
      if (inspectorCalls.has(profile.samples[i])) continue
      samples.push(idMap.get(profile.samples[i]))
      timeDeltas.push(profile.timeDeltas[i])
    }
  }

  return { nodes, samples, timeDeltas, startTime: profiles[0].startTime, endTime: profiles.at(-1).endTime }
}

function isInspectorPost (callFrame) {
  return callFrame.functionName === 'post' && callFrame.url === 'node:inspector'
}

function label (callFrame) {
  const name = callFrame.functionName || '(anonymous)'
  if (!callFrame.url) return name
  return `${name} ${callFrame.url.replace(/^file:\/\//, '')}:${callFrame.lineNumber + 1}`
}

/**
 * @param {ReturnType<typeof merge>} profile
 */
function topText (profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)

  const self = new Map()
  const total = new Map()
  let sampled = 0
  let nonWork = 0

  for (let i = 0; i < profile.samples.length; i++) {
    const delta = profile.timeDeltas[i] // time since the previous sample (or profile start)
    const leaf = byId.get(profile.samples[i])
    if (NON_WORK.has(leaf.callFrame.functionName)) {
      nonWork += delta
      continue
    }
    sampled += delta
    const leafLabel = label(leaf.callFrame)
    self.set(leafLabel, (self.get(leafLabel) ?? 0) + delta)
    const seen = new Set()
    for (let id = leaf.id; id !== undefined; id = parent.get(id)) {
      const frame = label(byId.get(id).callFrame)
      if (seen.has(frame)) continue // count recursion once
      seen.add(frame)
      total.set(frame, (total.get(frame) ?? 0) + delta)
    }
  }

  const format = (title, map) => {
    const rows = [...map].sort((a, b) => b[1] - a[1]).slice(0, TOP_N)
      .map(([name, us]) => {
        const ms = (us / 1000).toFixed(1).padStart(10)
        return `${ms} ms ${(100 * us / sampled).toFixed(1).padStart(5)}%  ${name}`
      })
    return `== ${title} (top ${TOP_N}, % of busy time) ==\n${rows.join('\n')}\n`
  }

  return [
    `iterations merged: ${profile.nodes[0].children.length}`,
    `busy time: ${(sampled / 1000).toFixed(1)} ms; idle/program/gc: ${(nonWork / 1000).toFixed(1)} ms`,
    '',
    format('self time', self),
    format('total time (inclusive)', total),
  ].join('\n')
}

/**
 * @param {object[]} profiles one V8 profile per timed iteration
 * @param {string} output path of the merged `.cpuprofile`; the hot list goes next to it as `.top.txt`
 */
function writeTopList (profiles, output) {
  const merged = merge(profiles)
  fs.writeFileSync(output, JSON.stringify(merged))
  fs.writeFileSync(output.replace(/\.cpuprofile$/, '') + '.top.txt', topText(merged))
}

module.exports = { writeTopList }
