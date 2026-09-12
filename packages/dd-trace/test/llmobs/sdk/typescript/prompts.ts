import tracer from 'dd-trace';

const llmobs = tracer.init().llmobs;
const prompts = llmobs.prompts;

async function promptManagement () {
  const prompt = await prompts.getPrompt('greeting', {
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
  await prompts.refreshPrompt('greeting');
  prompts.clearPromptCache({ hot: true, warm: false });
  await prompts.createPrompt('greeting', 'Hello {name}', { title: 'Greeting', envIds: [] });
  await prompts.createPromptVersion('greeting', 'Hello again {name}', { userVersion: '2', envIds: [] });
  await prompts.updatePrompt('greeting', { title: '', description: '' });
  await prompts.updatePromptVersion('greeting', 2, { description: '', envIds: [] });
  await prompts.deletePrompt('greeting');
  await prompts.listPrompts();
  await prompts.listPromptVersions('greeting');
}
