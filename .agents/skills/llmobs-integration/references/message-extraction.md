# Message Extraction Patterns

Provider-specific patterns for converting messages to standard LLMObs format.

## Standard Format

All plugins must convert messages to:

```javascript
[{
  content: string,  // Message text
  role: string      // 'user', 'assistant', 'system', 'tool', etc.
}]
```

## Input Message Patterns

### OpenAI Format

```javascript
// Input
{
  messages: [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'Hello' }
  ]
}

// Extraction
extractInputMessages(inputs) {
  if (Array.isArray(inputs.messages)) {
    return inputs.messages.map(msg => ({
      content: msg.content || '',
      role: msg.role || 'user'
    }))
  }
  return []
}
```

### Anthropic Format

```javascript
// Input
{
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
  ]
}

// Extraction
extractInputMessages(inputs) {
  if (Array.isArray(inputs.messages)) {
    return inputs.messages.map(msg => ({
      content: Array.isArray(msg.content)
        ? msg.content.map(c => c.text || c.type).join('')
        : msg.content || '',
      role: msg.role
    }))
  }
  return []
}
```

### Google GenAI Format

```javascript
// Input
{
  contents: [
    { role: 'user', parts: [{ text: 'Hello' }] }
  ]
}

// Extraction
extractInputMessages(inputs) {
  if (Array.isArray(inputs.contents)) {
    return inputs.contents.map(item => ({
      content: item.parts?.map(p => p.text).join('') || '',
      role: item.role || 'user'
    }))
  }
  return []
}
```

### Prompt String Format

```javascript
// Input
{ prompt: 'Hello, AI!' }

// Extraction
extractInputMessages(inputs) {
  if (inputs.prompt) {
    return [{ content: inputs.prompt, role: 'user' }]
  }
  return []
}
```

### Direct String Format

```javascript
// Input
'Hello, AI!'

// Extraction
extractInputMessages(inputs) {
  if (typeof inputs === 'string') {
    return [{ content: inputs, role: 'user' }]
  }
  return []
}
```

## Output Message Patterns

### OpenAI Format

```javascript
// Output
{
  choices: [
    { message: { role: 'assistant', content: 'Hi there!' } }
  ]
}

// Extraction
extractOutputMessages(results) {
  if (results.choices && results.choices[0]) {
    const message = results.choices[0].message || {}
    return [{
      content: message.content || '',
      role: message.role || 'assistant'
    }]
  }
  return [{ content: '', role: '' }]
}
```

### Anthropic Format

```javascript
// Output
{
  role: 'assistant',
  content: [{ type: 'text', text: 'Hi there!' }]
}

// Extraction
extractOutputMessages(results) {
  if (results.content && Array.isArray(results.content)) {
    const text = results.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('')
    return [{
      content: text,
      role: results.role || 'assistant'
    }]
  }
  return [{ content: '', role: '' }]
}
```

### Google GenAI Format

```javascript
// Output
{
  candidates: [
    { content: { role: 'model', parts: [{ text: 'Hi there!' }] } }
  ]
}

// Extraction
extractOutputMessages(results) {
  if (results.candidates && results.candidates[0]) {
    const content = results.candidates[0].content
    const text = content?.parts?.map(p => p.text).join('') || ''
    return [{
      content: text,
      role: 'assistant'  // Normalize 'model' to 'assistant'
    }]
  }
  return [{ content: '', role: '' }]
}
```

### Direct Text Format

```javascript
// Output
{ text: 'Hi there!' }

// Extraction
extractOutputMessages(results) {
  if (results.text) {
    return [{
      content: results.text,
      role: 'assistant'
    }]
  }
  return [{ content: '', role: '' }]
}
```

## Advanced Patterns

### Streaming
Accumulate content across chunks using a buffer, extract delta from each chunk (`chunk.choices?.[0]?.delta?.content`), tag final accumulated content.

### Function Calling
For function calls, stringify the function_call object as content. Preserve 'tool' role for tool responses.

### Multi-Turn Conversations
Extract all messages in order, preserving roles and sequence.

## Error Handling

Always return empty messages on error:

```javascript
setLLMObsTags(ctx) {
  const span = ctx.currentStore?.span
  if (!span) return

  this.tagInputMessages(span, this.extractInputMessages(ctx.arguments?.[0]))

  if (ctx.error) {
    // Tag empty output on error
    this.tagOutputMessages(span, [{ content: '', role: '' }])
    return
  }

  // Normal extraction
  this.tagOutputMessages(span, this.extractOutputMessages(ctx.result))
}
```

### Multimodal Content
For images/multimodal, map array content and join: `msg.content.map(c => c.text || c.type || '[image]').join(' ')`.

## Best Practices

1. Always handle null/undefined with `|| ''` and `|| []` defaults
2. Preserve role types (except normalize 'model' → 'assistant')
3. Handle arrays - many formats use arrays for content parts
4. Return `[{content: '', role: ''}]` on error
5. Join multi-part content with `.join('')`
6. Maintain message ordering in conversations
7. Keep 'system', 'tool', 'function' roles intact
