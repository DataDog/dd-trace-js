'use strict'

const assert = require('node:assert/strict')
const vm = require('node:vm')

const { describe, it } = require('mocha')

describe('sirun diff summary', () => {
  it('compares instruction means over variants available in every summary', () => {
    const before = summary({ shared: 100, unavailable: 10_000 })
    const after = summary({ shared: 200 })
    const goal = summary({ shared: 50, unavailable: 5_000 })
    const elements = renderSummary(before, after, goal)

    assert.strictEqual(elements['prev-instructions'].innerHTML, 100)
    assert.strictEqual(elements['curr-instructions'].innerHTML, 200)
    assert.strictEqual(elements['diff-instructions'].innerHTML, '100.00')
    assert.strictEqual(elements['goal-instructions'].innerHTML, 50)
    assert.strictEqual(elements['diff-goal-instructions'].innerHTML, '300.00')
  })

  it('omits instruction means when no variant is available in every summary', () => {
    const before = summary({ before: 100 })
    const after = summary({ after: 200 })
    const goal = summary({ goal: 50 })
    const elements = renderSummary(before, after, goal)

    assert.strictEqual(elements['prev-instructions'].innerHTML, '')
    assert.strictEqual(elements['curr-instructions'].innerHTML, '')
    assert.strictEqual(elements['diff-instructions'].innerHTML, '')
    assert.strictEqual(elements['goal-instructions'].innerHTML, '')
    assert.strictEqual(elements['diff-goal-instructions'].innerHTML, '')
  })
})

/**
 * @param {Record<string, number>} instructions
 */
function summary (instructions) {
  const variants = {}
  for (const [name, value] of Object.entries(instructions)) {
    variants[name] = {
      instructions: value,
      summary: {
        'max.res.size': { mean: 1 },
      },
    }
  }
  return { benchmark: variants }
}

/**
 * @param {ReturnType<typeof summary>} before
 * @param {ReturnType<typeof summary>} after
 * @param {ReturnType<typeof summary>} goal
 */
function renderSummary (before, after, goal) {
  const goalPath = require.resolve('./goal.json')
  const diffPath = require.resolve('./diff-recent')
  const originalGoal = require.cache[goalPath]
  let html
  try {
    require.cache[goalPath] = { exports: goal, loaded: true }
    delete require.cache[diffPath]
    const renderDiff = require('./diff-recent')
    html = renderDiff(before, after).html
  } finally {
    if (originalGoal === undefined) {
      delete require.cache[goalPath]
    } else {
      require.cache[goalPath] = originalGoal
    }
    delete require.cache[diffPath]
  }

  const elements = new Proxy({}, {
    get (target, name) {
      target[name] ??= {
        appendChild () {},
        getContext () {},
        innerHTML: '',
        style: {},
      }
      return target[name]
    },
  })
  const script = html.match(/<script>\n\n([\s\S]+?) {4}<\/script>/)[1]
  const context = {
    Chart: Object.assign(function () {}, { defaults: { plugins: { legend: {} } } }),
    document: {
      createElement: () => elements.created,
      getElementById: (name) => elements[name],
    },
    marked: () => '',
  }
  vm.runInNewContext(script, context)
  return elements
}
