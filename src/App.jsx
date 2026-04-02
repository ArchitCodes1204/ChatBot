import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { fetchModels, streamChat } from './ollama';
import './index.css';

function App() {
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('llama3.2');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    // Load models on mount
    fetchModels().then(data => {
      setModels(data);
      if (data.length > 0) {
        const defaultModel = data.find(m => m.name.includes('llama3')) || data[0];
        setSelectedModel(defaultModel.name);
      }
    });

    // Check for standard greeting
    if (messages.length === 0) {
      setMessages([{ role: 'assistant', content: "Hello! I'm running locally via Ollama. How can I help you today?" }]);
    }
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isGenerating]);

  const handleSend = async () => {
    if (!input.trim() || isGenerating) return;

    const userMessage = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setIsGenerating(true);

    try {
      const generator = streamChat(newMessages, selectedModel);
      let assistantContent = '';
      
      // Keep track of the message internally, wait to add to array
      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      for await (const chunk of generator) {
        assistantContent += chunk;
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1].content = assistantContent;
          return updated;
        });
      }
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ **Error:** Failed to communicate with local Ollama. Ensure Ollama is running and OLLAMA_ORIGINS="*" is set.' }]);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <button className="new-chat-btn" onClick={() => setMessages([])}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          New chat
        </button>
        <div style={{marginTop: 'auto', padding: '1rem 0', color: 'var(--text-secondary)', fontSize: '0.85rem'}}>
          Powered by Ollama
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="chat-area">
        <header className="header">
          <select 
            className="model-selector" 
            value={selectedModel} 
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={isGenerating}
          >
            {models.length === 0 && <option value="llama3.2">llama3.2</option>}
            {models.map(m => (
              <option key={m.digest} value={m.name}>{m.name}</option>
            ))}
          </select>
        </header>

        <div className="messages-container">
          {messages.map((msg, index) => (
            <div key={index} className="message">
              <div className={`message-avatar ${msg.role === 'user' ? 'user-avatar' : 'ai-avatar'}`}>
                {msg.role === 'user' ? 'U' : 'AI'}
              </div>
              <div className="message-content">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
            </div>
          ))}
          {isGenerating && messages[messages.length - 1]?.role !== 'assistant' && (
            <div className="message">
              <div className="message-avatar ai-avatar">AI</div>
              <div className="message-content">
                <div className="typing-indicator">
                  <span className="typing-dot"></span>
                  <span className="typing-dot"></span>
                  <span className="typing-dot"></span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-container">
          <div className="input-box">
            <textarea 
              className="input-field"
              placeholder="Ask local model anything..."
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
              }}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <button 
              className="send-btn" 
              onClick={handleSend}
              disabled={!input.trim() || isGenerating}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
