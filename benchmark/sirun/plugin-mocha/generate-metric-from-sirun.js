const fs = require('fs')

const lines = fs.readFileSync('output.ndjson', 'utf8').trim().split('\n')

lines.forEach(sirunTestJson => {
  const json = JSON.parse(sirunTestJson)

  const numIterations = json.iterations.length
  const avgWalltime = json.iterations.reduce(
    (avg, { 'cpu.pct.wall.time': wallTime }) => avg + wallTime / numIterations, 0
  )
  const fileContent = JSON.stringify({
    series: [
      {
        metric: 'dd.ci.mocha.overhead',
        points: [[Math.floor(Date.now() / 1000), avgWalltime]],
        tags: [
          `test.variant:${json.variant}`,
          `git.branch:${process.env.CIRCLE_BRANCH}`,
          `runtime.version:${json.nodeVersion}`
        ]
      }
    ]
  })
  fs.writeFileSync(`output-${json.variant}.json`, fileContent)
})
