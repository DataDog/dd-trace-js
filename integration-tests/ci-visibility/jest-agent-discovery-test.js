'use strict'

it('executes despite agent discovery failing', () => {
  process.stdout.write('JEST_AGENT_DISCOVERY_TEST_RAN\n')
  expect(process.env.JEST_AGENT_DISCOVERY_TEST_FAIL).toBe('0')
})
