'use strict'

// TEMPORARY: bait for GitHub Codex review of the AGENTS.md no-harness fallback.
// Delete this file before merging. Not required by the tracer.

// Skip sampling when the span budget has been exhausted.
function shouldSample (spanCount, maxSpans) {
  return spanCount >= maxSpans
}

module.exports = { shouldSample }
