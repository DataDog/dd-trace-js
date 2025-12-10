'use strict'

describe('Jest Hook Instrumentation Test Suite', () => {
  let suiteData = []
  let testData = []

  // Suite-level hooks - should be parented to suite span
  beforeAll(() => {
    console.log('beforeAll hook executed')
    suiteData.push('beforeAll')
  })

  afterAll(() => {
    console.log('afterAll hook executed')
    suiteData.push('afterAll')
  })

  // Test-level hooks - should be parented to test span
  beforeEach(() => {
    console.log('beforeEach hook executed')
    testData.push('beforeEach')
  })

  afterEach(() => {
    console.log('afterEach hook executed')
    testData.push('afterEach')
  })

  test('test with all hooks', () => {
    console.log('test executed')
    expect(true).toBe(true)
  })

  test('second test to verify hook execution', () => {
    console.log('second test executed')
    expect(testData.length).toBeGreaterThan(0)
  })

  describe('nested describe block', () => {
    beforeAll(() => {
      console.log('nested beforeAll hook executed')
      suiteData.push('nested-beforeAll')
    })

    afterAll(() => {
      console.log('nested afterAll hook executed')
      suiteData.push('nested-afterAll')
    })

    test('nested test', () => {
      console.log('nested test executed')
      expect(suiteData.length).toBeGreaterThan(0)
    })
  })
})

describe('Async Hook Test Suite', () => {
  let asyncData = null

  beforeAll(async () => {
    console.log('async beforeAll hook started')
    await new Promise(resolve => setTimeout(resolve, 10))
    asyncData = 'initialized'
    console.log('async beforeAll hook completed')
  })

  afterAll(async () => {
    console.log('async afterAll hook started')
    await new Promise(resolve => setTimeout(resolve, 10))
    asyncData = null
    console.log('async afterAll hook completed')
  })

  test('test with async hooks', () => {
    console.log('test with async data:', asyncData)
    expect(asyncData).toBe('initialized')
  })
})

describe('Hook Error Test Suite', () => {
  // This hook should fail and be attributed to the suite
  beforeAll(() => {
    console.log('beforeAll hook that will fail')
    // Uncomment to test error handling
    // throw new Error('beforeAll hook error')
  })

  test('test that should run if beforeAll succeeds', () => {
    console.log('test after beforeAll')
    expect(true).toBe(true)
  })
})
