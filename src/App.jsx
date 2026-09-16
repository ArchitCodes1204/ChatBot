import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { streamChat, fetchModels, pickDefaultModel, fitToBudget, probeModelLimits, FALLBACK_MODEL } from './api';
import './index.css';
import { extractTextFromFile } from './utils/fileParser';

const isEnvKeySet = !!import.meta.env.VITE_GROQ_API_KEY;

const greetingFor = (hasKey) => hasKey
  ? "Hello! I'm NoteBot. How can I help you take notes and brainstorm today?"
  : "Hello! I'm NoteBot. Please enter your API Key in the sidebar to start chatting.";

const isGreeting = (msg) => msg.role === 'assistant'
  && (msg.content.includes("Hello! I'm powered by Groq") || msg.content.includes("Hello! I'm NoteBot"));

function App() {
  const [apiKey, setApiKey] = useState(() => isEnvKeySet ? import.meta.env.VITE_GROQ_API_KEY : (localStorage.getItem('groqApiKey') || ''));
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messagesEndRef = useRef(null);
  const [extractedFiles, setExtractedFiles] = useState([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(FALLBACK_MODEL);
  const [retryNotice, setRetryNotice] = useState('');
  const fileInputRef = useRef(null);

  const hasKey = isEnvKeySet || apiKey.trim() !== '';

  useEffect(() => {
    if (!isEnvKeySet) {
      localStorage.setItem('groqApiKey', apiKey);
    }
  }, [apiKey]);

  useEffect(() => {
    setMessages(prev => {
      if (prev.length > 1 || (prev.length === 1 && !isGreeting(prev[0]))) return prev;
      const greetingMsg = greetingFor(hasKey);
      if (prev.length === 1 && prev[0].content === greetingMsg) return prev;
      return [{ role: 'assistant', content: greetingMsg }];
    });
  }, [hasKey, messages.length]);

  // Groq retires model ids regularly, so ask the account which ones are live
  // instead of hard-coding one that may already be decommissioned.
  useEffect(() => {
    let cancelled = false;
    const key = apiKey.trim();
    if (!key) return;

    fetchModels(key).then(list => {
      if (cancelled) return;
      setModels(list);
      setModel(current => list.some(m => m.id === current) ? current : pickDefaultModel(list));
    });

    return () => { cancelled = true; };
  }, [apiKey]);

  // Learn this model's rate limit up front so the first message is sized
  // against the real budget instead of the conservative fallback.
  useEffect(() => {
    const key = apiKey.trim();
    if (key && model) probeModelLimits(model, key);
  }, [apiKey, model]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isGenerating]);

  const handleSend = async () => {
    if ((!input.trim() && extractedFiles.length === 0) || isGenerating) return;

    if (!apiKey.trim()) {
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ **Missing API Key:** Please enter your Groq API Key in the sidebar first.' }]);
      return;
    }

    const currentInput = input;
    const userMessage = { role: 'user', content: currentInput.trim() || 'Attached files.' };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setIsGenerating(true);

    try {
      const chatHistory = newMessages.filter(m => !isGreeting(m));
      
      let contextPrefix = '';
      if (extractedFiles.length > 0) {
        let fileContents = extractedFiles.map(f => `--- Start of ${f.name} ---\n${f.content}\n--- End of ${f.name} ---\n`).join('\n');
        contextPrefix = "You are NoteBot, an advanced AI assistant. Your task is to help users understand, summarize, and extract information from uploaded files and images. Below is the text extracted from the user's uploaded files.\nUse this content as the MAIN SOURCE OF TRUTH to answer the user's questions. If the user asks about the files and the answer is not in the text, clearly say: 'This information is not available in the uploaded content.'\n\nUploaded Content:\n" + fileContents + "\n\n";
      }

      // Attachments and long histories are what blow the per-minute token
      // limit, so clip both to what this model can actually accept.
      const { messages: API_messages, notes } = fitToBudget({
        systemPrompt: contextPrefix,
        history: chatHistory,
        model,
      });
      if (notes.length > 0) {
        setRetryNotice(`To stay within the model's rate limit, ${notes.join(' and ')}.`);
      }

      const generator = streamChat(API_messages, model, apiKey.trim(), {
        onRetry: ({ attempt, maxRetries, seconds }) =>
          setRetryNotice(`Rate limit reached — retrying in ${seconds}s (attempt ${attempt} of ${maxRetries})...`),
      });
      let assistantContent = '';
      let placeholderAdded = false;

      for await (const chunk of generator) {
        assistantContent += chunk;
        if (!placeholderAdded) {
          // Only create the bubble once the first token lands, so the typing
          // indicator stays visible while the model is still thinking.
          placeholderAdded = true;
          setMessages(prev => [...prev, { role: 'assistant', content: assistantContent }]);
          continue;
        }
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: assistantContent } : m
        ));
      }

      if (!placeholderAdded) {
        setMessages(prev => [...prev, { role: 'assistant', content: '_(No response returned by the model.)_' }]);
      }
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ **Error:** ${err.message}` }]);
    } finally {
      setIsGenerating(false);
      setRetryNotice('');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files || files.length === 0) return;
    
    setIsExtracting(true);
    const newExtractedFiles = [];
    
    for (const file of files) {
      try {
        const text = await extractTextFromFile(file);
        newExtractedFiles.push({
          id: Math.random().toString(36).substring(7),
          name: file.name,
          content: text,
          type: file.type
        });
      } catch (err) {
        console.error("Error reading file:", err);
        alert(`Failed to read ${file.name}. ${err.message}`);
      }
    }
    
    setExtractedFiles(prev => [...prev, ...newExtractedFiles]);
    setIsExtracting(false);
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (id) => {
    setExtractedFiles(prev => prev.filter(f => f.id !== id));
  };

  return (
    <div className="app-container">
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)}></div>}

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', color: 'var(--text-primary)', fontSize: '1.2rem', fontWeight: 700 }}>
          <div style={{width: '32px', height: '32px', borderRadius: '50%', background: 'var(--accent-gradient)', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"></path><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"></path><path d="M12 18v4"></path><path d="M18 12h4"></path><path d="M6 12H2"></path></svg>
          </div>
          NoteBot
        </div>
        <button className="new-chat-btn" onClick={() => { setMessages([]); setExtractedFiles([]); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          New chat
        </button>
        
        {!isEnvKeySet && (
          <div style={{ padding: '1.5rem 0' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 500 }}>
              API Key (Groq)
            </label>
            <input 
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="gsk_..."
              style={{
                width: '100%',
                padding: '0.6rem 0.75rem',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                outline: 'none',
                boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.02)'
              }}
            />
            <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" style={{ fontSize: '0.8rem', color: '#1fca7b', display: 'inline-block', marginTop: '0.5rem', textDecoration: 'none', fontWeight: 500 }}>
              Get API Key
            </a>
          </div>
        )}

        <div style={{marginTop: 'auto', padding: '1rem 0', color: 'var(--text-secondary)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem'}}>
          Powered by NoteBot
        </div>
      </aside>

      <main className="chat-area">
        <header className="header">
          <button className="mobile-menu-btn" onClick={() => setSidebarOpen(true)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <select
            className="model-selector"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={isGenerating || models.length === 0}
            title="Model"
          >
            {(models.length > 0 ? models : [{ id: model, name: model }]).map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </header>

        <div className="messages-container">
          {messages.map((msg, index) => (
            <div key={index} className={`message ${msg.role === 'user' ? 'user-message' : 'ai-message'}`}>
              <div className={`message-avatar ${msg.role === 'user' ? 'user-avatar' : 'ai-avatar'}`}>
                {msg.role === 'user' ? '' : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"></path><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"></path><path d="M12 18v4"></path><path d="M18 12h4"></path><path d="M6 12H2"></path></svg>}
              </div>
              <div className="message-content">
                <div className="message-bubble">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              </div>
            </div>
          ))}
          {isGenerating && messages[messages.length - 1]?.role !== 'assistant' && (
            <div className="message ai-message">
              <div className="message-avatar ai-avatar">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"></path><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"></path><path d="M12 18v4"></path><path d="M18 12h4"></path><path d="M6 12H2"></path></svg>
              </div>
              <div className="message-content">
                <div className="message-bubble">
                  <div className="typing-indicator">
                    <span className="typing-dot"></span>
                    <span className="typing-dot"></span>
                    <span className="typing-dot"></span>
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        
        {retryNotice && (
          <div className="retry-notice">{retryNotice}</div>
        )}

        <div className="input-container">
          <div className={`input-box ${extractedFiles.length > 0 ? 'with-files' : ''}`}>
            {extractedFiles.length > 0 && (
              <div className="file-chips">
                {extractedFiles.map(f => (
                  <div key={f.id} className="file-chip">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16h16V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                    <span style={{maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{f.name}</span>
                    <button className="remove-file-btn" onClick={() => removeFile(f.id)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            
            {isExtracting && (
              <div className="loading-files">
                <div className="typing-indicator" style={{padding:0}}><span className="typing-dot"></span><span className="typing-dot"></span><span className="typing-dot"></span></div>
                Extracting text...
              </div>
            )}

            <div className="input-row">
              <button 
                className="attachment-btn" 
                onClick={() => fileInputRef.current?.click()} 
                disabled={isExtracting || isGenerating}
                title="Attach Files"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
              </button>
              <input 
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                style={{ display: 'none' }}
                multiple
                accept=".pdf,.docx,.txt,image/*"
              />

              <textarea 
                className="input-field"
                placeholder="Reply to NoteBot..."
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
                disabled={(!input.trim() && extractedFiles.length === 0) || isGenerating || isExtracting}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
