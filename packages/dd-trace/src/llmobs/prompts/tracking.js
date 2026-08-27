'use strict'

const trackedPrompts = new WeakMap()

function trackPrompt (rendered, prompt) {
  if (Array.isArray(rendered)) trackedPrompts.set(rendered, prompt)
  return rendered
}

function getTrackedPrompt (...values) {
  for (const value of values) {
    if (!value || typeof value !== 'object') continue

    const prompt = trackedPrompts.get(value)
    if (prompt) return prompt

    if (Array.isArray(value)) continue

    let candidates
    try {
      candidates = Object.values(value)
    } catch {
      continue
    }

    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object') {
        const prompt = trackedPrompts.get(candidate)
        if (prompt) return prompt
      }
    }
  }
}

module.exports = { getTrackedPrompt, trackPrompt }
