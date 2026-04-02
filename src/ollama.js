export async function fetchModels() {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    if (!response.ok) return [];
    const data = await response.json();
    return data.models || [];
  } catch (e) {
    console.error("Failed to fetch Ollama models:", e);
    return [];
  }
}

export async function* streamChat(messages, model = 'llama3.2') {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true })
  });

  if (!response.ok) {
    throw new Error('Network response was not ok');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    // A chunk could have multiple lines if streamed fast
    const lines = chunk.split('\n').filter(line => line.trim() !== '');
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.message?.content) {
        yield parsed.message.content;
      }
    }
  }
}
