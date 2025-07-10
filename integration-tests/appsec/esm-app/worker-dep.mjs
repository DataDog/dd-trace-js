function dummyOperation (a) {
  return a + 'dummy operation with concat in worker-dep'
}

dummyOperation('should not crash')
