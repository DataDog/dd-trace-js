'use strict'

require('../../setup/mocha')
const { setTimeout } = require('node:timers/promises')

const mutexGenerator = require('../../../src/debugger/devtools_client/lock')

describe('lock mechanism', function () {
  it('should work as a mutex', async function () {
    const lock = mutexGenerator()
    const order = []
    async function worker (time, id) {
      const release = await lock()
      await setTimeout(time)
      order.push(id)
      release()
    }
    await Promise.all([worker(300, 1), worker(200, 2), worker(100, 3)])
    expect(order).to.deep.equal([1, 2, 3])
  })

  it('should be possible to have independent locks', async function () {
    const lock1 = mutexGenerator()
    const lock2 = mutexGenerator()
    const order = []
    async function worker1 (time, id) {
      const release = await lock1()
      await setTimeout(time)
      order.push(id)
      release()
    }
    async function worker2 (time, id) {
      const release = await lock2()
      await setTimeout(time)
      order.push(id)
      release()
    }
    await Promise.all([worker1(300, 'a1'), worker2(100, 'b1'), worker1(200, 'a2')])
    expect(order).to.deep.equal(['b1', 'a1', 'a2'])
  })
})
