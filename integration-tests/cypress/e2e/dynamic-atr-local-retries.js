/* eslint-disable */

for (const retries of [0, { runMode: 0, openMode: 0 }, 5]) {
  it(`test retries ${JSON.stringify(retries)}`, { retries }, () => {
    throw new Error('test retry override')
  })
}

for (const retries of [0, { runMode: 0, openMode: 0 }]) {
  describe(`suite retries ${JSON.stringify(retries)}`, { retries }, () => {
    it('fails', () => {
      throw new Error('suite retry override')
    })
  })
}
