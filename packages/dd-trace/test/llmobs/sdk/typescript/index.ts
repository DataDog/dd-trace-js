// @ts-ignore
import tracer from 'dd-trace';

const llmobs = tracer.init({
  llmobs: {
    mlApp: 'test',
    agentlessEnabled: false
  }
}).llmobs;

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
test.runChain('hello');
