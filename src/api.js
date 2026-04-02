export async function fetchModels(apiKey) {
  const fallbackModels = [
    { name: 'llama3-8b-8192', id: 'llama3-8b-8192', digest: 'llama3-8b-8192' },
    { name: 'llama3-70b-8192', id: 'llama3-70b-8192', digest: 'llama3-70b-8192' },
    { name: 'mixtral-8x7b-32768', id: 'mixtral-8x7b-32768', digest: 'mixtral-8x7b-32768' },
    { name: 'gemma-7b-it', id: 'gemma-7b-it', digest: 'gemma-7b-it' },
    { name: 'gemma2-9b-it', id: 'gemma2-9b-it', digest: 'gemma2-9b-it' }
  ];

  if (!apiKey) return fallbackModels;
  
  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) throw new Error('Bad response');
    const data = await response.json();
    return data.data.map(m => ({ name: m.id, id: m.id, digest: m.id }));
  } catch (e) {
    console.error("Failed to fetch models", e);
    return fallbackModels; // fallback if fetching fails
  }
}

export async function* streamChat(messages, model = 'llama3-8b-8192', apiKey) {
  if (!apiKey) {
    throw new Error("API Key configuration is missing. Please add your Groq API key in the sidebar.");
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ 
      model, 
      messages, 
      stream: true 
    })
  });

  if (!response.ok) {
    const err = await response.text();
    let errMsg = err;
    try {
      const parsed = JSON.parse(err);
      if (parsed.error && parsed.error.message) {
        errMsg = parsed.error.message;
      }
    } catch(e) {}
    throw new Error('Groq API Error: ' + errMsg);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    // Handle multiple lines in a single chunk
    const lines = chunk.split('\n').filter(line => line.trim() !== '' && line.trim() !== 'data: [DONE]');
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch (e) {
          // ignore parse errors for partial chunks
        }
      }
    }
  }
}
