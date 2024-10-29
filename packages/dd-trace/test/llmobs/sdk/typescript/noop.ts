// @ts-ignore
import tracer from 'dd-trace';
import * as assert from 'assert';
const llmobs = tracer.llmobs;

class Test {
  @llmobs.decorate({ kind: 'agent' })
  runChain (input: string) {
    llmobs.annotate({
      inputData: 'this is a',
      outputData: 'test'
    })

    return 'world'
  }
}

const test: Test = new Test();
assert.equal(test.runChain('hello'), 'world')