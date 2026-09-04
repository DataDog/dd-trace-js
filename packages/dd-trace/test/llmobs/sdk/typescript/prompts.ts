import tracer from 'dd-trace';

const llmobs = tracer.init().llmobs;

async function promptManagement () {
  const prompt = await llmobs.getPrompt('greeting', {
    version: 2,
    fallback: () => ({ template: 'Hello {name}', version: 'local' }),
    targetingKey: 'user-1',
    attributes: { tier: 'premium', enabled: true, score: 1 }
  });
  const messages = prompt.format({ name: 'Ada', count: 2 });
  const annotation = prompt.toAnnotation({ name: 'Ada', count: 2 });
  if (typeof prompt.template !== 'string') {
    // @ts-expect-error Managed prompt templates are immutable.
    prompt.template[0].content = 'Changed';
  }
  llmobs.annotationContext({ prompt: annotation }, () => messages);
  await llmobs.refreshPrompt('greeting');
  llmobs.clearPromptCache({ hot: true, warm: false });
  const template = [{ role: 'user', content: 'Hello {name}' }];
  await llmobs.createPrompt('greeting', template, { title: 'Greeting', envIds: [] });
  await llmobs.createPromptVersion('greeting', template, { userVersion: '2', envIds: [] });
  await llmobs.updatePrompt('greeting', { title: '', description: '' });
  await llmobs.updatePromptVersion('greeting', 2, { description: '', envIds: [] });
  await llmobs.deletePrompt('greeting');
  await llmobs.listPrompts();
  await llmobs.listPromptVersions('greeting');
}
