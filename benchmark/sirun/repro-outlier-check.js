'use strict'

// TEMPORARY (DataDog/dd-trace-js#11256, revert before merge): repro loop stop condition.
// Exits 1 when an iteration of any variant used more than 2x the median CPU time of that
// variant's iterations for about the same instruction count (within 5%): the process ran
// slower without doing more work. Prints the variant's iterations.
const fs = require('fs')

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

let found = false
for (const line of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  if (!line.trim()) continue
  let obj
  try { obj = JSON.parse(line) } catch { continue }
  const iterations = (obj.iterations || []).map(it => ({
    cpu: (it['user.time'] || 0) + (it['system.time'] || 0),
    instructions: it.instructions || 0,
    raw: it
  }))
  if (iterations.length < 3) continue
  const cpuMedian = median(iterations.map(it => it.cpu))
  const instructionsMedian = median(iterations.map(it => it.instructions))
  const outliers = iterations.filter(it =>
    cpuMedian > 0 && it.cpu > 2 * cpuMedian &&
    instructionsMedian > 0 && Math.abs(it.instructions - instructionsMedian) <= 0.05 * instructionsMedian
  )
  if (outliers.length === 0) continue
  found = true
  console.error(`REPRO outlier: ${obj.name}/${obj.variant}, CPU time median ${Math.round(cpuMedian)}, ` +
    `instructions median ${Math.round(instructionsMedian)}`)
  for (const [i, it] of iterations.entries()) {
    const stats = Object.entries(it.raw).map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v) : v}`)
    console.error(`  #${i + 1}${outliers.includes(it) ? ' (outlier)' : ''}: ${stats.join(' ')}`)
  }
}
process.exit(found ? 1 : 0)
