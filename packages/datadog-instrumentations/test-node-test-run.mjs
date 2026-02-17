import test from 'node:test'

test('passing test', (t) => {
  t.pass()
})

test('test with subtests', async (t) => {
  await t.test('subtest 1', (t) => t.pass())
  await t.test('subtest 2', (t) => t.pass())
})
