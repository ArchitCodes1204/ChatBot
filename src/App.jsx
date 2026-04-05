import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { streamChat } from './api';
import './index.css';
import logo from './assets/notebot_logo.png';

// Check if there is an environment variable provided fit check
const isEnvKeySet = !!import.meta.env.VITE_GROQ_API_KEY;

function App() {
  const [apiKey, setApiKey] = useState(() => isEnvKeySet ? import.meta.env.VITE_GROQ_API_KEY : (localStorage.getItem('groqApiKey') || ''));
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messagesEndRef = useRef(null);

  // Save API key to local storage when changed manually (only if not using env)
  useEffect(() => {
    if (!isEnvKeySet) {
      localStorage.setItem('groqApiKey', apiKey);
    }
  }, [apiKey]);


  useEffect(() => {
    // Check for standard greeting
    setMessages(prev => {
      // Only update if there are no messages, or if the only message is our default greeting
      if (prev.length === 0 || (prev.length === 1 && prev[0].role === 'assistant' && (prev[0].content.includes("Hello! I'm powered by Groq") || prev[0].content.includes("Hello! I'm NoteBot")))) {
        const hasKey = isEnvKeySet || (apiKey && apiKey.trim() !== '');
        const greetingMsg = hasKey 
          ? "Hello! I'm NoteBot. How can I help you take notes and brainstorm today?" 
          : "Hello! I'm NoteBot. Please enter your API Key in the sidebar to start chatting.";
        
        if (prev.length === 1 && prev[0].content === greetingMsg) {
          return prev;
        }
        return [{ role: 'assistant', content: greetingMsg }];
      }
      return prev;
    });
  }, [apiKey]); // Refetch if api key changes

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isGenerating]);

  const handleSend = async () => {
    if (!input.trim() || isGenerating) return;

    if (!apiKey.trim()) {
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ **Missing API Key:** Please enter your Groq API Key in the sidebar first.' }]);
      return;
    }

    const userMessage = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setIsGenerating(true);

    try {
      // Don't send our initial instructional message to Groq if it's the only AI message
      const chatHistory = newMessages.filter(m => !(m.role === 'assistant' && (m.content.includes("Hello! I'm powered by Groq") || m.content.includes("Hello! I'm NoteBot"))));
      
      const generator = streamChat(chatHistory, 'llama-3.1-8b-instant', apiKey.trim());
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
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ **Error:** ${err.message}` }]);
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
      {/* Sidebar Overlay for Mobile */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)}></div>}

      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', color: 'var(--text-primary)', fontSize: '1.2rem', fontWeight: 700 }}>
          <img src={logo} alt="NoteBot Logo" style={{ width: '32px', height: '32px', borderRadius: '8px' }} />
          NoteBot
        </div>
        <button className="new-chat-btn" onClick={() => setMessages([])}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          New chat
        </button>
        
        {/* Only show API Key input if the environment variable is not set */}
        {!isEnvKeySet && (
          <div style={{ padding: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Groq API Key
            </label>
            <input 
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="gsk_..."
              style={{
                width: '100%',
                padding: '0.5rem',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                fontSize: '0.9rem'
              }}
            />
            <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: 'var(--accent-color)', display: 'block', marginTop: '0.5rem', textDecoration: 'none' }}>
              Get API Key
            </a>
          </div>
        )}

        <div style={{marginTop: 'auto', padding: '1rem 0', color: 'var(--text-secondary)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem'}}>
          Powered by NoteBot
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="chat-area">
        <header className="header">
          <button className="mobile-menu-btn" onClick={() => setSidebarOpen(true)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <div className="model-selector" style={{ cursor: 'default', opacity: 0.8 }}>
            llama-3.1-8b-instant
          </div>
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
              placeholder="Message AI..."
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
