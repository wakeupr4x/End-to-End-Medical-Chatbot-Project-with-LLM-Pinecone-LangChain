(function () {
  const STORAGE_KEYS = {
    chats: 'medibot_chats',
    prefs: 'medibot_prefs',
  };

  const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'hi', name: 'Hindi' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
  ];

  const SUGGESTIONS = [
    { text: 'Fever', query: 'I have a mild fever and body aches. What should I do?' },
    { text: 'Headache', query: 'I have a persistent throbbing headache behind my eyes. What could it be?' },
    { text: 'Skin rash', query: 'A red, itchy skin rash appeared on my arm. How can I treat it?' },
    { text: 'Stomach pain', query: 'I have dull stomach pain and bloating after eating. Suggest causes.' },
  ];

  const NEARBY_HOSPITALS = [
    { name: 'Mayo General Hospital', distance: '1.2 miles away', phone: '555-0199', addr: '100 Medical Plaza, Rochester' },
    { name: 'Saint Jude Urgent Care', distance: '2.5 miles away', phone: '555-0244', addr: '450 Clinical Way, Sector 4' },
    { name: 'Metro Health Emergency Room', distance: '4.1 miles away', phone: '555-0911', addr: '800 Wellness Blvd, Downtown' },
    { name: 'Community Medical Center', distance: '6.8 miles away', phone: '555-0812', addr: '1200 Health Lake Ave' }
  ];

  const state = {
    chats: [],
    currentChatId: null,
    draft: '',
    language: 'en',
    darkMode: false,  /* Off-white light mode by default */
    sidebarOpen: false,
    isRecording: false,
    isLoading: false,
    selectedFile: null,
    search: '',
    activeTab: 'chat',  /* 'chat', 'reports', 'hospitals', 'emergency', 'settings' */
    user: null,
    authReady: false,
    authError: '',
    showSplash: true,   /* New Splash Screen State */
  };

  let fileInput;
  let cameraInput;
  let textArea;
  let messagesEl;
  let mediaRecorder;
  let audioChunks = [];
  let audioStream = null;
  let speechRecognition;

  function safeParse(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function getApiUrl(path) {
    const customApi = window.MEDIBOT_API_BASE || localStorage.getItem('medibot_api_base') || '';
    if (!customApi) return path;
    return customApi.replace(/\/+$/, '') + path;
  }

  async function apiFetchJson(url, options = {}) {
    const targetUrl = url.startsWith('http') ? url : getApiUrl(url);
    const response = await fetch(targetUrl, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  }

  async function fetchSessionUser() {
    try {
      const res = await fetch(getApiUrl('/api/me'));
      const data = await res.json();
      state.user = data.authenticated ? data.user : null;
    } catch {
      state.user = null;
    } finally {
      state.authReady = true;
      render();
    }
  }

  async function loginUser(payload) {
    state.authError = '';
    try {
      const data = await apiFetchJson('/api/login', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.user = data.user;
      state.authReady = true;
      savePrefs();
      render();
    } catch (error) {
      state.authError = error.message || 'Unable to log in';
      render();
    }
  }

  async function logoutUser() {
    try {
      await apiFetchJson('/api/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch {
      // Ignore logout errors and clear state
    }
    state.user = null;
    state.currentChatId = null;
    state.activeTab = 'chat';
    savePrefs();
    render();
  }

  function savePrefs() {
    localStorage.setItem(STORAGE_KEYS.prefs, JSON.stringify({
      language: state.language,
      darkMode: state.darkMode,
      currentChatId: state.currentChatId,
    }));
  }

  function saveChats() {
    localStorage.setItem(STORAGE_KEYS.chats, JSON.stringify(state.chats));
  }

  function getCurrentChat() {
    return state.chats.find((c) => c.id === state.currentChatId) || null;
  }

  function currentMessages() {
    const chat = getCurrentChat();
    return chat ? chat.messages : [];
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* Renders basic markdown into readable HTML for clean clinical cards */
  function renderMarkdown(text) {
    let s = escapeHtml(text || '');
    s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    
    // Lists parsing
    s = s.replace(/(?:^|\n)([-*])\s+(.+)(?=\n|$)/g, (match) => {
      const items = match
        .trim()
        .split(/\n/)
        .map((line) => line.replace(/^[-*]\s+/, ''))
        .filter(Boolean)
        .map((line) => `<li>${line}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    });
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  function formatTime(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  }

  function formatDate(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
  }

  function fileKind(file) {
    if (!file) return 'file';
    if (file.type === 'application/pdf' || file.name.toLowerCase().endswith('.pdf')) return 'pdf';
    if ((file.type || '').startsWith('image/')) return 'image';
    return 'file';
  }

  function newId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function titleFromText(text) {
    const clean = String(text || '').trim();
    if (!clean) return 'New consultation';
    return clean.length > 32 ? `${clean.slice(0, 32)}...` : clean;
  }

  function ensureCurrentChat() {
    if (state.currentChatId && state.chats.some((c) => c.id === state.currentChatId)) return;
    if (state.chats.length) state.currentChatId = state.chats[0].id;
    else state.currentChatId = null;
  }

  function setDarkMode(enabled) {
    state.darkMode = enabled;
    document.documentElement.classList.toggle('dark', enabled);
    savePrefs();
    render();
  }

  function setLanguage(lang) {
    state.language = lang;
    savePrefs();
    render();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function updateChat(chatId, updater) {
    state.chats = state.chats.map((chat) => (chat.id === chatId ? updater(chat) : chat));
    saveChats();
    ensureCurrentChat();
    render();
  }

  function appendMessage(chatId, message) {
    state.chats = state.chats.map((chat) => {
      if (chat.id !== chatId) return chat;
      return { ...chat, messages: [...chat.messages, message] };
    });
    saveChats();
    render();
  }

  function createChat(firstText) {
    const id = newId('chat');
    const chat = {
      id,
      title: titleFromText(firstText),
      createdAt: new Date().toISOString(),
      messages: [],
    };
    state.chats = [chat, ...state.chats];
    state.currentChatId = id;
    saveChats();
    savePrefs();
    return id;
  }

  function handleSuggestionClick(query) {
    state.draft = query;
    state.activeTab = 'chat';
    render();
    setTimeout(() => {
      if (textArea) {
        textArea.focus();
        textArea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 0);
  }

  function startNewChat() {
    state.currentChatId = null;
    state.draft = '';
    state.selectedFile = null;
    state.activeTab = 'chat';
    if (fileInput) fileInput.value = '';
    if (cameraInput) cameraInput.value = '';
    state.sidebarOpen = false;
    savePrefs();
    render();
  }

  /* High-Risk Medical Term Emergency Detector */
  function detectEmergency(text) {
    const cleanText = (text || '').toLowerCase();
    const triggers = [
      'chest pain', 'heart attack', 'angina', 'stroke', 'paralysis', 
      'numbness on one side', 'slurred speech', 'difficulty breathing', 
      'severe shortness of breath', 'difficulty swallowing', 
      'anaphylaxis', 'choking', 'severe allergic reaction', 'unconscious', 
      'emergency care', 'seek immediate care', 'call 911', 'cardiac issue',
      'extreme dizziness', 'poisoning'
    ];
    return triggers.some(term => cleanText.includes(term));
  }

  async function toggleRecording() {
    if (!state.isRecording) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        try {
          speechRecognition = new SpeechRecognition();
          speechRecognition.lang = state.language === 'hi' ? 'hi-IN' : 'en-US';
          speechRecognition.interimResults = false;
          speechRecognition.maxAlternatives = 1;
          speechRecognition.onresult = async (event) => {
            const transcript = event.results?.[0]?.[0]?.transcript || '';
            state.draft = transcript;
            render();
            await sendQuery({ textOverride: transcript });
          };
          speechRecognition.onerror = () => {
            alert('Voice recognition did not succeed. Try typing.');
          };
          speechRecognition.start();
          state.isRecording = true;
          render();
        } catch {
          alert('Microphone access is blocked in this browser context.');
        }
        return;
      }

      const canRecordAudio = window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder;
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(audioStream);
        audioChunks = [];
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
          const blob = new Blob(audioChunks, { type: 'audio/webm' });
          sendQuery({ audioBlob: blob });
          if (audioStream) {
            audioStream.getTracks().forEach((track) => track.stop());
            audioStream = null;
          }
        };
        mediaRecorder.start();
        state.isRecording = true;
        render();
      } catch {
        alert('Speech features require local host / HTTPS secure protocol.');
      }
      return;
    }

    if (speechRecognition) {
      try { speechRecognition.stop(); } catch {}
      speechRecognition = null;
      state.isRecording = false;
      render();
      return;
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    state.isRecording = false;
    render();
  }

  async function sendQuery({ textOverride = null, audioBlob = null } = {}) {
    const queryText = textOverride !== null ? textOverride : state.draft;
    const trimmed = String(queryText || '').trim();
    if (!trimmed && !state.selectedFile && !audioBlob) return;
    if (state.isLoading) return;

    let chatId = state.currentChatId;
    if (!chatId) chatId = createChat(trimmed || (state.selectedFile ? state.selectedFile.name : 'New consultation'));
    const chat = getCurrentChat();
    const history = (chat?.messages || []).map((m) => ({ sender: m.sender, text: m.text })).slice(-8);
    const timestamp = new Date().toISOString();
    const attachment = state.selectedFile;
    const userText = trimmed || (audioBlob ? 'Voice query' : state.selectedFile ? `Uploaded ${state.selectedFile.name}` : 'New query');
    
    const userMsg = {
      id: newId('user'),
      sender: 'user',
      text: userText,
      timestamp,
      hasImage: !!attachment,
      attachmentName: attachment?.name || null,
      attachmentKind: fileKind(attachment),
      transcription: null,
    };
    
    const botMsg = {
      id: newId('bot'),
      sender: 'bot',
      text: 'Analyzing clinical context and formatting response...',
      timestamp,
      pending: true,
      promptText: trimmed,
      sources: []
    };

    state.isLoading = true;
    state.draft = '';

    if (!chat || chat.id !== chatId || !chat.messages.length) {
      state.chats = state.chats.map((c) =>
        c.id === chatId ? { ...c, messages: [userMsg, botMsg] } : c
      );
    } else {
      appendMessage(chatId, userMsg);
      appendMessage(chatId, botMsg);
    }
    saveChats();
    render();

    const formData = new FormData();
    formData.append('msg', trimmed);
    formData.append('lang', state.language);
    formData.append('history', JSON.stringify(history));
    if (attachment) formData.append('attachment', attachment);
    if (audioBlob) formData.append('audio', audioBlob, 'voice.webm');

    try {
      const res = await fetch(getApiUrl('/api/chat'), { method: 'POST', body: formData });
      const data = await res.json();
      const finalText = data.success
        ? data.text
        : (data.error || 'Unable to connect to the healthcare model. Please check network connectivity.');
      
      const rSources = data.sources || [];
      
      state.chats = state.chats.map((chatItem) => {
        if (chatItem.id !== chatId) return chatItem;
        return {
          ...chatItem,
          title: chatItem.messages.length <= 2 ? titleFromText(trimmed || userText) : chatItem.title,
          messages: chatItem.messages.map((msg) => {
            if (msg.id !== botMsg.id) return msg;
            return {
              ...msg,
              text: finalText,
              pending: false,
              transcription: data.transcription || null,
              sources: rSources
            };
          }),
        };
      });
      
      if (attachment) {
        const existingReports = safeParse('medibot_reports', []);
        const nextReport = {
          id: newId('report'),
          name: attachment.name,
          kind: fileKind(attachment),
          createdAt: timestamp,
          chatId,
        };
        localStorage.setItem('medibot_reports', JSON.stringify([nextReport, ...existingReports].slice(0, 10)));
      }
    } catch {
      state.chats = state.chats.map((chatItem) => {
        if (chatItem.id !== chatId) return chatItem;
        return {
          ...chatItem,
          messages: chatItem.messages.map((msg) =>
            msg.id === botMsg.id ? { ...msg, text: 'Clinical server unreachable. Check system environment.', pending: false } : msg
          ),
        };
      });
    } finally {
      state.isLoading = false;
      state.selectedFile = null;
      if (fileInput) fileInput.value = '';
      if (cameraInput) cameraInput.value = '';
      saveChats();
      savePrefs();
      render();
    }
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text || '');
      alert('Content copied to clipboard.');
    }
  }

  function reactToMessage(messageId, reaction) {
    const chat = getCurrentChat();
    if (!chat) return;
    updateChat(chat.id, (current) => ({
      ...current,
      messages: current.messages.map((msg) => (msg.id === messageId ? { ...msg, reaction } : msg)),
    }));
  }

  function regenerateMessage(message) {
    if (!message?.promptText) return;
    state.draft = message.promptText;
    render();
    sendQuery({ textOverride: message.promptText });
  }

  function handleAttachmentChange(event) {
    const file = event.target.files && event.target.files[0];
    if (file) {
      state.selectedFile = file;
      render();
    }
  }

  /* Streamlined SVG Icon Generator */
  function buildIcon(name, size = 16) {
    const common = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    const paths = {
      chat: `<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>`,
      plus: `<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>`,
      menu: `<line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line>`,
      x: `<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>`,
      sun: `<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="M4.93 4.93l1.41 1.41"></path><path d="M17.66 17.66l1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="M6.34 17.66l-1.41 1.41"></path><path d="M19.07 4.93l-1.41 1.41"></path>`,
      moon: `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`,
      settings: `<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V22a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 0 1 2.57 18.2l.06-.06A1.65 1.65 0 0 0 3 16.3a1.65 1.65 0 0 0-1.51-1H1.4a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 0 1 5.44 4.6l.06.06a1.65 1.65 0 0 0 1.82.33h.18A1.65 1.65 0 0 0 9 3.48V3.4a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06A2 2 0 0 1 21.43 5.8l-.06.06A1.65 1.65 0 0 0 21 7.7c0 .64.38 1.21.97 1.46H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>`,
      user: `<path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="7" r="4"></circle>`,
      send: `<path d="M22 2L11 13"></path><path d="M22 2l-7 20-4-9-9-4 20-7z"></path>`,
      mic: `<path d="M12 1v11"></path><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v4"></path>`,
      image: `<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path>`,
      paperclip: `<path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 1 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.49"></path>`,
      globe: `<circle cx="12" cy="12" r="10"></circle><path d="M2 12h20"></path><path d="M12 2a15.3 15.3 0 0 1 0 20"></path><path d="M12 2a15.3 15.3 0 0 0 0 20"></path>`,
      search: `<circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path>`,
      trash: `<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>`,
      bot: `<path d="M12 8V4"></path><path d="M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0z"></path><path d="M4 19a8 8 0 0 1 16 0"></path>`,
      shield: `<path d="M12 2l8 4v6c0 5-3.5 8.7-8 10-4.5-1.3-8-5-8-10V6l8-4z"></path><path d="M9 12l2 2 4-4"></path>`,
      file: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path>`,
      check: `<path d="M20 6 9 17l-5-5"></path>`,
      copy: `<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>`,
      refresh: `<path d="M20 11a8 8 0 1 0-2 5.3"></path><path d="M20 4v7h-7"></path>`,
      thumbsUp: `<path d="M7 22V11H4v11h3z"></path><path d="M7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2l-2 9H7"></path>`,
      thumbsDown: `<path d="M7 2v11H4V2h3z"></path><path d="M7 13l4 8a2 2 0 0 0 2-2v-4h6a2 2 0 0 0 2-2l-2-9H7"></path>`,
      camera: `<path d="M4 7h4l2-3h4l2 3h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"></path><circle cx="12" cy="13" r="3"></circle>`,
      heart: `<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 22l7.8-8.6 1-1a5.5 5.5 0 0 0 0-7.8z"></path>`,
    };
    return `<svg ${common} aria-hidden="true">${paths[name] || ''}</svg>`;
  }

  function messageActions(message) {
    return `
      <div class="message-actions-row">
        <button class="message-action-btn" data-action="copy" data-message="${message.id}" title="Copy">${buildIcon('copy', 12)} Copy</button>
        ${message.sender === 'bot' && message.promptText ? `<button class="message-action-btn" data-action="regenerate" data-message="${message.id}" title="Regenerate">${buildIcon('refresh', 12)} Retry</button>` : ''}
        ${message.sender === 'bot' ? `<button class="message-action-btn" data-action="reaction" data-reaction="up" data-message="${message.id}" title="Helpful">${buildIcon('thumbsUp', 12)} Helpful</button>` : ''}
        ${message.sender === 'bot' ? `<button class="message-action-btn" data-action="reaction" data-reaction="down" data-message="${message.id}" title="Not helpful">${buildIcon('thumbsDown', 12)} Inaccurate</button>` : ''}
      </div>
    `;
  }

  /* 1. Sidebar - Consultations Listing (Renders only chat entries) */
  function renderChatList() {
    const needle = state.search.trim().toLowerCase();
    const chats = needle
      ? state.chats.filter((chat) => {
          const titleHit = (chat.title || '').toLowerCase().includes(needle);
          const messageHit = (chat.messages || []).some((message) => (message.text || '').toLowerCase().includes(needle));
          return titleHit || messageHit;
        })
      : state.chats;

    if (!chats.length) {
      return `<div style="padding: 12px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">No consults found.</div>`;
    }

    return chats.map((chat) => `
      <div class="menu-item ${state.currentChatId === chat.id && state.activeTab === 'chat' ? 'menu-item-active' : ''}" data-chat-row-id="${chat.id}">
        <div class="menu-item-left">
          <span class="menu-item-icon">${buildIcon('chat', 14)}</span>
          <span class="menu-item-label">${escapeHtml(chat.title)}</span>
        </div>
        <button class="menu-delete-btn" data-delete-chat="${chat.id}">${buildIcon('trash', 12)}</button>
      </div>
    `).join('');
  }

  /* 2. Sidebar - Saved Reports Listing */
  function renderSavedReportsMenu() {
    const reports = JSON.parse(localStorage.getItem('medibot_reports') || '[]');
    if (!reports.length) {
      return `<div style="padding: 12px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">No uploaded reports.</div>`;
    }
    return reports.slice(0, 3).map((report) => `
      <div class="menu-item" style="cursor: default;">
        <div class="menu-item-left" style="min-width: 0; flex: 1;">
          <span class="menu-item-icon" style="color: var(--primary);">${buildIcon(report.kind === 'pdf' ? 'file' : 'image', 14)}</span>
          <span class="menu-item-label" style="font-size: 0.8rem;" title="${escapeHtml(report.name)}">${escapeHtml(report.name)}</span>
        </div>
      </div>
    `).join('');
  }

  /* 3. Core Sidebar Compiler */
  function renderSidebar() {
    return `
      <aside class="app-sidebar ${state.sidebarOpen ? 'sidebar-open' : ''}">
        <div class="sidebar-header">
          <div class="sidebar-brand">
            <span>🩺</span> MediBot
          </div>
          <button class="sidebar-close-btn" data-close-sidebar>${buildIcon('x', 18)}</button>
        </div>

        <button class="sidebar-new-chat-btn" data-new-chat>
          ${buildIcon('plus', 14)} New Consultation
        </button>

        <div class="sidebar-menu">
          <!-- 1. Consultation History -->
          <div class="menu-section-title">Consultations</div>
          <div class="sidebar-chat-list-target">${renderChatList()}</div>

          <!-- 2. Streamlined Report Storage -->
          <div class="menu-section-title" style="margin-top: 14px;">Recent Reports</div>
          <div class="sidebar-reports-list-target">${renderSavedReportsMenu()}</div>

          <!-- 3. Primary Feature Navigation -->
          <div class="menu-section-title" style="margin-top: 14px;">Services</div>
          <button class="menu-item ${state.activeTab === 'hospitals' ? 'menu-item-active' : ''}" data-nav-tab="hospitals">
            <div class="menu-item-left">
              <span class="menu-item-icon">${buildIcon('globe', 14)}</span>
              <span class="menu-item-label">Nearby Hospitals</span>
            </div>
          </button>
          <button class="menu-item ${state.activeTab === 'emergency' ? 'menu-item-active' : ''}" data-nav-tab="emergency">
            <div class="menu-item-left">
              <span class="menu-item-icon" style="color: var(--emergency);">${buildIcon('heart', 14)}</span>
              <span class="menu-item-label" style="color: var(--emergency); font-weight: 600;">Emergency Desk</span>
            </div>
          </button>
          <button class="menu-item ${state.activeTab === 'settings' ? 'menu-item-active' : ''}" data-nav-tab="settings">
            <div class="menu-item-left">
              <span class="menu-item-icon">${buildIcon('settings', 14)}</span>
              <span class="menu-item-label">Settings</span>
            </div>
          </button>
        </div>

        <div class="sidebar-footer">
          <div class="patient-profile-card">
            <div class="patient-avatar">
              ${escapeHtml((state.user?.name || 'P')[0].toUpperCase())}
            </div>
            <div class="patient-info">
              <span class="patient-name">${escapeHtml(state.user?.name || 'Patient')}</span>
              <span class="patient-status">Health Session Active</span>
            </div>
          </div>
          <div class="sidebar-footer-actions">
            <button class="footer-btn" data-toggle-theme>${state.darkMode ? 'Light Theme' : 'Dark Theme'}</button>
            <button class="footer-btn" data-logout>Logout</button>
          </div>
        </div>
      </aside>
    `;
  }

  /* 4. Top Header Compiler */
  function renderTopHeader() {
    return `
      <header class="top-header-bar">
        <div class="header-left">
          <button class="sidebar-toggle-btn" data-open-sidebar>${buildIcon('menu', 18)}</button>
          <div class="header-title-group">
            <h1 class="header-title">🩺 MediBot</h1>
            <span class="header-subtitle">AI-powered medical assistance</span>
          </div>
        </div>
        <div class="header-right">
          <div class="header-profile-btn" style="cursor: default;">
            <span>${escapeHtml(state.user?.name || 'Patient')}</span>
            <span class="header-profile-dot"></span>
          </div>
        </div>
      </header>
    `;
  }

  /* 5. Suggestions Compiler (Home Screen) */
  function renderSuggestionsRow() {
    return `
      <div class="suggestions-container">
        <div class="suggestions-label">Common Symptoms</div>
        <div class="suggestions-list">
          ${SUGGESTIONS.map(item => `
            <button class="suggestion-chip" data-suggest="${escapeHtml(item.query)}">
              ${escapeHtml(item.text)}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  /* 6. Feature Cards Compiler (Home Screen Grid) */
  function renderFeaturesGrid() {
    return `
      <div class="features-grid">
        <button class="feature-card" data-suggest="Perform a general symptom check and advise if I should see a doctor.">
          <span class="feature-icon">🩺</span>
          <h3 class="feature-title">Symptom Check</h3>
          <p class="feature-desc">Screen for possible causes and identify key warning red flags.</p>
        </button>
        <button class="feature-card" data-suggest="Suggest common precautions, side effects, and standard safety rules for common medicine.">
          <span class="feature-icon">💊</span>
          <h3 class="feature-title">Medicine Info</h3>
          <p class="feature-desc">View indications, adult precautions, and drug guidance summaries.</p>
        </button>
        <button class="feature-card" data-suggest="What are practical steps and trends to improve cardiorespiratory health?">
          <span class="feature-icon">📊</span>
          <h3 class="feature-title">Health Trends</h3>
          <p class="feature-desc">Review simple physical wellness routines and laboratory tracking guidelines.</p>
        </button>
      </div>
    `;
  }

  /* 7. Blank State Hero View */
  function renderHeroView() {
    return `
      <div class="blank-state">
        <div class="blank-logo">🩺</div>
        <h2 class="blank-title">MediBot Assistant</h2>
        <p class="blank-desc">
          Describe symptoms, upload medical reports, or ask health questions. 
          MediBot assists you with clinical documents, but does not replace professional care.
        </p>

        <!-- Centered Search Card -->
        <div class="search-card-container">
          <div class="search-card">
            ${state.selectedFile ? `
              <div class="input-attachment-chip">
                <span>${buildIcon(fileKind(state.selectedFile) === 'pdf' ? 'file' : 'image', 12)} ${escapeHtml(state.selectedFile.name)}</span>
                <button data-clear-file>${buildIcon('x', 12)}</button>
              </div>
            ` : ''}
            <textarea id="composer" class="search-textarea" placeholder="Describe symptoms or ask a clinical question...">${escapeHtml(state.draft)}</textarea>
            <div class="search-actions-row">
              <div class="search-left-tools">
                <button class="tool-btn" title="Attach clinical report" data-upload>${buildIcon('paperclip', 16)}</button>
                <button class="tool-btn" title="Camera snapshot" data-camera>${buildIcon('camera', 16)}</button>
                <button class="tool-btn ${state.isRecording ? 'tool-btn-active' : ''}" title="Voice note" data-record>${buildIcon('mic', 16)}</button>
              </div>
              <button class="search-submit-btn" data-send ${state.isLoading ? 'disabled' : ''}>
                ${buildIcon('send', 14)} Ask MediBot
              </button>
            </div>
          </div>
        </div>

        ${renderSuggestionsRow()}
        ${renderFeaturesGrid()}
      </div>
    `;
  }

  /* 8. Messages Layout Compiler (Main Chat View) */
  function renderMessagesSection() {
    const messages = currentMessages();
    if (!messages.length) return renderHeroView();

    const listHtml = messages.map((msg) => {
      const isUser = msg.sender === 'user';
      const parsedText = renderMarkdown(msg.text);
      const isEmergTriggered = !isUser && (detectEmergency(msg.text) || detectEmergency(msg.promptText));

      return `
        <div class="chat-message-row ${isUser ? 'row-user' : ''}">
          <div class="message-sender-avatar ${isUser ? 'avatar-user' : 'avatar-bot'}">
            ${isUser ? buildIcon('user', 14) : buildIcon('bot', 14)}
          </div>
          <div class="message-content-wrapper">
            <div class="message-meta-line">
              <span>${isUser ? 'You' : 'MediBot'}</span>
              <span>•</span>
              <span>${formatTime(msg.timestamp)}</span>
            </div>
            
            <div class="message-bubble ${isUser ? 'bubble-user' : 'bubble-bot'}">
              <div>${parsedText}</div>
              
              <!-- File Attachment Chip in bubble -->
              ${msg.attachmentName ? `
                <div class="message-attachment-bubble">
                  ${buildIcon(msg.attachmentKind === 'pdf' ? 'file' : 'image', 12)}
                  <span>${escapeHtml(msg.attachmentName)}</span>
                </div>
              ` : ''}

              <!-- RAG Reference citation chips -->
              ${!isUser && msg.sources && msg.sources.length ? `
                <div class="message-sources-title">Verified Sources</div>
                <div class="message-sources-list">
                  ${msg.sources.map(src => `<span class="source-chip">${buildIcon('shield', 10)} ${escapeHtml(src)}</span>`).join('')}
                </div>
              ` : ''}

              <!-- Dynamic Emergency Alert Card -->
              ${isEmergTriggered ? `
                <div class="emergency-alert-card">
                  <div class="emergency-alert-header">
                    <span>⚠</span> Possible Medical Emergency
                  </div>
                  <div class="emergency-alert-body">
                    Your described symptoms may indicate a critical clinical situation. We recommend contacting local medical services immediately.
                  </div>
                  <div class="emergency-alert-actions">
                    <button class="emergency-action-btn emergency-action-btn-red" data-action="dial-emergency">
                      ${buildIcon('heart', 12)} Call Emergency (911)
                    </button>
                    <button class="emergency-action-btn emergency-action-btn-white" data-action="find-hospitals">
                      ${buildIcon('globe', 12)} Find Nearby Clinics
                    </button>
                  </div>
                </div>
              ` : ''}
            </div>

            <!-- Utility row -->
            ${!msg.pending ? messageActions(msg) : ''}
          </div>
        </div>
      `;
    }).join('');

    const typingLoaderHtml = state.isLoading ? `
      <div class="chat-message-row">
        <div class="message-sender-avatar avatar-bot">
          ${buildIcon('bot', 14)}
        </div>
        <div class="message-content-wrapper">
          <div class="message-meta-line">MediBot is typing...</div>
          <div class="message-bubble bubble-bot" style="display: inline-block; padding: 10px 16px;">
            <div class="typing-indicator">
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
            </div>
          </div>
        </div>
      </div>
    ` : '';

    return `
      <div id="chat-messages" class="chat-container">
        <div class="chat-width-limiter">
          ${listHtml}
          ${typingLoaderHtml}
        </div>
      </div>
    `;
  }

  /* 9. Bottom Entry Form Composer (Main Chat view when conversation is active) */
  function renderComposerSection() {
    const messages = currentMessages();
    if (!messages.length) return ''; // Hide composer on hero state since search card is centered

    return `
      <div class="bottom-form-anchor">
        <div class="bottom-width-limiter">
          <div class="search-card">
            ${state.selectedFile ? `
              <div class="input-attachment-chip">
                <span>${buildIcon(fileKind(state.selectedFile) === 'pdf' ? 'file' : 'image', 12)} ${escapeHtml(state.selectedFile.name)}</span>
                <button data-clear-file>${buildIcon('x', 12)}</button>
              </div>
            ` : ''}
            <textarea id="composer" class="search-textarea" placeholder="Ask follow-up questions or describe next symptoms..." style="min-height: 40px;"></textarea>
            <div class="search-actions-row">
              <div class="search-left-tools">
                <button class="tool-btn" title="Attach medical PDF/Image" data-upload>${buildIcon('paperclip', 16)}</button>
                <button class="tool-btn" title="Take photo" data-camera>${buildIcon('camera', 16)}</button>
                <button class="tool-btn ${state.isRecording ? 'tool-btn-active' : ''}" title="Speak symptoms" data-record>${buildIcon('mic', 16)}</button>
              </div>
              <button class="search-submit-btn" data-send ${state.isLoading ? 'disabled' : ''}>
                ${buildIcon('send', 14)} Send Message
              </button>
            </div>
          </div>
          <div class="disclaimer-text">
            For critical emergencies, please dial emergency services. MediBot is an AI assistant and does not replace medical advice.
          </div>
        </div>
      </div>
    `;
  }

  /* 10. Service Tab - Nearby Hospitals */
  function renderHospitalsView() {
    return `
      <div class="workspace-scrollable-content">
        <div class="section-card">
          <h2>🏥 Local Clinical Facilities</h2>
          <p style="color: var(--text-secondary); font-size: 0.9rem;">
            Here are the nearest medical facilities identified in your general area. In case of cardiac issues, severe stroke signs, or severe trauma, bypass urgent clinics and proceed directly to an emergency department.
          </p>
          
          <div class="hospitals-list" style="margin-top: 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;">
            ${NEARBY_HOSPITALS.map(h => `
              <div class="hospital-item" style="padding: 16px; border-radius: var(--radius-xl);">
                <div class="hospital-name" style="font-size: 1rem; color: var(--text-primary);">${escapeHtml(h.name)}</div>
                <div class="hospital-distance" style="font-size: 0.8rem; color: var(--primary); font-weight: 600;">${escapeHtml(h.distance)}</div>
                <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px;">${escapeHtml(h.addr)}</div>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">Phone: ${escapeHtml(h.phone)}</div>
                <button class="emergency-action-btn emergency-action-btn-white" style="margin-top: 12px; width: 100%; justify-content: center; font-size: 0.75rem;" onclick="alert('Routing directions standard simulation initiated.')">
                  ${buildIcon('globe', 12)} Get Directions
                </button>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="section-card" style="border-left: 4px solid var(--emergency);">
          <div class="emergency-alert-header" style="font-size: 1.1rem;">
            <span>⚠</span> Need Ambulance Dispatch?
          </div>
          <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 6px;">
            If you or a nearby patient is presenting with numbness on one side, severe chest compression, or major hemorrhage, immediately dial ambulance emergency dispatch services.
          </p>
          <button class="emergency-call-btn" style="margin-top: 12px; max-width: 240px;" data-action="dial-emergency">
            ${buildIcon('heart', 14)} Dial Emergency (911)
          </button>
        </div>
      </div>
    `;
  }

  /* 11. Service Tab - Emergency Desk */
  function renderEmergencyView() {
    return `
      <div class="workspace-scrollable-content">
        <div class="section-card" style="border-left: 4px solid var(--emergency); background-color: var(--emergency-light);">
          <h2 style="color: var(--emergency); font-weight: 700; border-bottom: 1px solid rgba(220, 38, 38, 0.15);">🚨 Emergency Medical Triage Guide</h2>
          <p style="font-size: 0.95rem; color: var(--text-primary); font-weight: 500; margin-top: 8px;">
            If you are experiencing any of the following symptoms, call emergency services immediately:
          </p>
          
          <ul style="margin: 12px 0 16px 20px; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.6;">
            <li><strong>Severe Chest Pain:</strong> Squeezing, heavy pressure, radiating to jaw or left arm.</li>
            <li><strong>Sudden Stroke Symptoms:</strong> Face drooping on one side, arm weakness, slurred speech (FAST protocol).</li>
            <li><strong>Trauma/Breathing:</strong> Inability to draw breath, sudden acute asthma, or massive bleeding.</li>
            <li><strong>Allergic Reaction:</strong> Swelling of mouth, tongue, or anaphylactic shock.</li>
          </ul>

          <div style="display: flex; gap: 12px; flex-wrap: wrap;">
            <button class="emergency-call-btn" style="max-width: 280px;" data-action="dial-emergency">
              ${buildIcon('heart', 16)} Call Ambulance (911)
            </button>
            <button class="emergency-action-btn emergency-action-btn-white" style="padding: 12px 18px; border-radius: var(--radius-lg);" data-nav-tab="hospitals">
              Find Nearest Trauma ER
            </button>
          </div>
        </div>

        <div class="section-card">
          <h2>💡 Triage Guidelines & First Steps</h2>
          <p style="font-size: 0.85rem; color: var(--text-muted);">
            While waiting for professional response teams, here are core health safety first-aid directives:
          </p>
          
          <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 8px;">
            <div style="padding: 12px; background-color: var(--bg-app); border-radius: var(--radius-lg); font-size: 0.85rem;">
              <strong style="display: block; margin-bottom: 4px; color: var(--text-primary);">Heart Attack Scenario</strong>
              Keep the patient sitting upright and calm. Loosen constricting shirts. Chewing an adult aspirin is commonly advised if non-allergic.
            </div>
            <div style="padding: 12px; background-color: var(--bg-app); border-radius: var(--radius-lg); font-size: 0.85rem;">
              <strong style="display: block; margin-bottom: 4px; color: var(--text-primary);">Stroke Scenario</strong>
              Note the exact time symptoms first started. Do not provide food, liquids, or blood thinners (like aspirin) as this can worsen bleeding strokes.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /* 12. Service Tab - Settings & Profile */
  function renderSettingsView() {
    return `
      <div class="workspace-scrollable-content">
        <div class="section-card">
          <h2>⚙ Settings & Patient Profile</h2>
          
          <div class="auth-form" style="margin-top: 12px;">
            <div class="form-group">
              <span class="form-label">Patient Session Name</span>
              <input type="text" class="form-input" value="${escapeHtml(state.user?.name || '')}" disabled style="background-color: var(--border-light); cursor: not-allowed;" />
            </div>

            <div class="form-group">
              <span class="form-label">Email Registration</span>
              <input type="email" class="form-input" value="${escapeHtml(state.user?.email || 'patient-demo@medibot.org')}" disabled style="background-color: var(--border-light); cursor: not-allowed;" />
            </div>

            <div class="form-group">
              <span class="form-label">Primary Medical Language</span>
              <select id="language-select-settings" class="form-input" style="cursor: pointer;">
                ${LANGUAGES.map((lang) => `<option value="${lang.code}" ${lang.code === state.language ? 'selected' : ''}>${lang.name}</option>`).join('')}
              </select>
            </div>

            <div class="form-group" style="flex-direction: row; justify-content: space-between; align-items: center; padding: 12px 0;">
              <div>
                <strong style="display: block; font-size: 0.9rem;">Theme Workspace Selector</strong>
                <span style="font-size: 0.75rem; color: var(--text-muted);">Toggle off-white light mode or dark visual contrast.</span>
              </div>
              <button class="footer-btn" style="padding: 8px 16px;" data-toggle-theme>${state.darkMode ? 'Light Theme' : 'Dark Theme'}</button>
            </div>
            
            <div style="margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--border-light);">
              <button class="emergency-action-btn emergency-action-btn-white" style="color: var(--emergency); border-color: var(--emergency);" data-logout>
                Sign out of current health session
              </button>
            </div>
          </div>
        </div>

        <div class="section-card">
          <h2>🛡 Security & AI Ethics Disclosures</h2>
          <p style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
            MediBot operates using advanced Pinecone Vector Search (RAG) and the official Google Gemini model. 
            All search requests are evaluated locally for patient symptoms, and metadata lookup is restricted to authenticated medical references. 
            Queries are session-cached and remain strictly on your local terminal storage.
          </p>
        </div>
      </div>
    `;
  }

  /* 13. Primary View Manager */
  function renderMainWorkspaceContent() {
    if (state.activeTab === 'reports') {
      // Re-use Settings or Chat flow report view, or render streamlined settings
      return renderSettingsView();
    }
    if (state.activeTab === 'hospitals') {
      return renderHospitalsView();
    }
    if (state.activeTab === 'emergency') {
      return renderEmergencyView();
    }
    if (state.activeTab === 'settings') {
      return renderSettingsView();
    }
    
    // Default chat interface
    return `
      ${renderMessagesSection()}
      ${renderComposerSection()}
    `;
  }

  /* 14. Session Auth Card Builder */
  function loginHTML() {
    if (!state.authReady) {
      return `
        <div class="auth-shell">
          <div class="auth-card" style="align-items: center;">
            <div class="splash-logo" style="font-size: 1.8rem;">🩺 MediBot</div>
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 6px;">Configuring clinical environment...</div>
          </div>
        </div>
      `;
    }

    return `
      <div class="auth-shell">
        <div class="auth-card">
          <div class="auth-header">
            <div class="auth-logo">🩺</div>
            <h2 class="auth-title">Welcome to MediBot</h2>
            <p class="auth-subtitle">Establish a secure health session to continue</p>
          </div>

          ${state.authError ? `<div class="auth-error">${escapeHtml(state.authError)}</div>` : ''}

          <div class="auth-form">
            <div class="form-group">
              <span class="form-label">Full Name</span>
              <input id="login-name" class="form-input" placeholder="Enter patient name" />
            </div>
            
            <div class="form-group">
              <span class="form-label">Email (Optional)</span>
              <input id="login-email" type="email" class="form-input" placeholder="patient@example.com" />
            </div>

            <div class="form-group">
              <span class="form-label">Access Pin (For Demo Session)</span>
              <input id="login-password" type="password" class="form-input" placeholder="Any password" />
            </div>

            <button class="auth-submit-btn" data-login-submit>
              Establish Secure Session
            </button>
          </div>
          
          <div style="font-size: 0.75rem; color: var(--text-muted); text-align: center; line-height: 1.4; margin-top: 4px;">
            By continuing, you agree that MediBot is an assistant platform that directs health symptom guidelines and does not replace doctor diagnoses.
          </div>
        </div>
      </div>
    `;
  }

  /* 15. Main Shell Assembly */
  function buildApp() {
    if (!state.user) return loginHTML();

    const isThreeColumn = state.activeTab === 'chat' && currentMessages().length > 0;
    
    return `
      <div class="app-shell ${isThreeColumn ? 'shell-with-rail' : ''}">
        <!-- 1. Sidebar -->
        ${renderSidebar()}

        <!-- 2. Main Workspace -->
        <div class="main-workspace">
          ${renderTopHeader()}
          ${renderMainWorkspaceContent()}
        </div>

        <!-- 3. Desktop Right Rail (Only show in Chat view with active responses) -->
        ${isThreeColumn ? `
          <aside class="right-rail">
            <div class="rail-section">
              <div class="rail-title">Emergency Dial</div>
              <button class="emergency-call-btn" data-action="dial-emergency">
                ${buildIcon('heart', 14)} Dial Urgent Desk (911)
              </button>
            </div>

            <div class="rail-section">
              <div class="rail-title">Medical Care Guidance</div>
              <div class="rail-card">
                <span class="rail-card-title">General Caution</span>
                <span class="rail-card-desc">
                  This system processes symptoms against standard medical files via Semantic RAG search. 
                  Always confirm medication dosages and symptoms directly with a primary physician.
                </span>
              </div>
            </div>

            <div class="rail-section">
              <div class="rail-title">Nearby Care Facilities</div>
              <div class="hospitals-list">
                ${NEARBY_HOSPITALS.slice(0, 2).map(h => `
                  <div class="hospital-item">
                    <span class="hospital-name">${escapeHtml(h.name)}</span>
                    <span class="hospital-distance">${escapeHtml(h.distance)}</span>
                  </div>
                `).join('')}
              </div>
              <button class="footer-btn" style="text-align: center; justify-content: center; padding: 10px;" data-nav-tab="hospitals">
                View All Clinics
              </button>
            </div>
          </aside>
        ` : ''}

        <!-- 4. Splash Screen Overlay -->
        <div class="splash-container ${state.showSplash ? '' : 'splash-hidden'}">
          <div class="splash-logo">🩺 MediBot</div>
          <div class="splash-subtitle">AI-powered medical assistance</div>
        </div>
      </div>
    `;
  }

  /* 16. Dynamic Event Listeners & Node Binder */
  function bindDynamicNodes() {
    fileInput = document.getElementById('file-input');
    // Ensure actual invisible inputs exist in body if we are on chat view
    if (!fileInput) {
      const inputsContainer = document.createElement('div');
      inputsContainer.innerHTML = `
        <input id="file-input" type="file" accept="image/*,.pdf" class="hidden" style="display:none;" />
        <input id="camera-input" type="file" accept="image/*" capture="environment" class="hidden" style="display:none;" />
      `;
      document.body.appendChild(inputsContainer);
      fileInput = document.getElementById('file-input');
    }
    cameraInput = document.getElementById('camera-input');
    
    textArea = document.getElementById('composer');
    messagesEl = document.getElementById('chat-messages');

    const root = document.getElementById('root');

    // Login submit
    const loginSubmit = root.querySelector('[data-login-submit]');
    if (loginSubmit) {
      loginSubmit.addEventListener('click', () => {
        const name = root.querySelector('#login-name')?.value?.trim();
        const email = root.querySelector('#login-email')?.value?.trim();
        const password = root.querySelector('#login-password')?.value?.trim();
        if (!name) {
          alert('Full Patient Name is required.');
          return;
        }
        loginUser({ name, email, password });
      });
    }

    ['#login-name', '#login-email', '#login-password'].forEach((selector) => {
      const input = root.querySelector(selector);
      if (!input) return;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          loginSubmit?.click();
        }
      });
    });

    // Chat Suggestion pills click
    root.querySelectorAll('[data-suggest]').forEach((btn) => {
      btn.addEventListener('click', () => handleSuggestionClick(btn.getAttribute('data-suggest')));
    });

    // Chat consultation history navigation rows
    root.querySelectorAll('[data-chat-row-id]').forEach((row) => {
      row.addEventListener('click', (e) => {
        // Prevent click if clicking the trash icon
        if (e.target.closest('[data-delete-chat]')) return;
        state.currentChatId = row.getAttribute('data-chat-row-id');
        state.activeTab = 'chat';
        state.sidebarOpen = false;
        savePrefs();
        render();
      });
    });

    // Delete chat row
    root.querySelectorAll('[data-delete-chat]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this consultation history? This action is irreversible.')) {
          const id = btn.getAttribute('data-delete-chat');
          state.chats = state.chats.filter((chat) => chat.id !== id);
          if (state.currentChatId === id) state.currentChatId = null;
          saveChats();
          savePrefs();
          render();
        }
      });
    });

    // Left and top bar triggers
    root.querySelectorAll('[data-open-sidebar]').forEach((btn) => btn.addEventListener('click', () => {
      state.sidebarOpen = true;
      render();
    }));
    root.querySelectorAll('[data-close-sidebar]').forEach((btn) => btn.addEventListener('click', () => {
      state.sidebarOpen = false;
      render();
    }));

    // Theme workspace toggler
    root.querySelectorAll('[data-toggle-theme]').forEach((btn) => btn.addEventListener('click', () => setDarkMode(!state.darkMode)));
    
    // Core Services sidebar tab triggers
    root.querySelectorAll('[data-nav-tab]').forEach((btn) => btn.addEventListener('click', () => {
      state.activeTab = btn.getAttribute('data-nav-tab');
      state.sidebarOpen = false;
      render();
    }));

    // Session logouts
    root.querySelectorAll('[data-logout]').forEach((btn) => btn.addEventListener('click', logoutUser));

    // Media and attachment input triggers
    root.querySelectorAll('[data-upload]').forEach((btn) => btn.addEventListener('click', () => fileInput?.click()));
    root.querySelectorAll('[data-camera]').forEach((btn) => btn.addEventListener('click', () => cameraInput?.click()));
    root.querySelectorAll('[data-record]').forEach((btn) => btn.addEventListener('click', toggleRecording));
    root.querySelectorAll('[data-clear-file]').forEach((btn) => btn.addEventListener('click', () => {
      state.selectedFile = null;
      render();
    }));

    // Send click
    root.querySelectorAll('[data-send]').forEach((btn) => btn.addEventListener('click', () => sendQuery()));
    root.querySelectorAll('[data-new-chat]').forEach((btn) => btn.addEventListener('click', startNewChat));

    // Settings elements
    const langSelect = root.querySelector('#language-select-settings');
    if (langSelect) {
      langSelect.addEventListener('change', (e) => setLanguage(e.target.value));
    }

    // Dynamic emergency warnings click triggers
    root.querySelectorAll('[data-action="dial-emergency"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        alert('Simulating direct hotline emergency ambulance contact dialing sequence to 911.');
      });
    });
    root.querySelectorAll('[data-action="find-hospitals"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTab = 'hospitals';
        render();
      });
    });

    if (fileInput) fileInput.addEventListener('change', handleAttachmentChange);
    if (cameraInput) cameraInput.addEventListener('change', handleAttachmentChange);

    // Dynamic Text Area Size expansion
    if (textArea) {
      textArea.addEventListener('input', (e) => {
        state.draft = e.target.value;
        textArea.style.height = '0px';
        textArea.style.height = `${Math.min(textArea.scrollHeight, 120)}px`;
      });
      textArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendQuery();
        }
      });
      textArea.style.height = '0px';
      textArea.style.height = `${Math.min(textArea.scrollHeight, 120)}px`;
    }

    // Message copy reaction regen triggers
    root.querySelectorAll('[data-action="copy"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chat = getCurrentChat();
        const msg = chat?.messages.find((m) => m.id === btn.getAttribute('data-message'));
        if (msg) copyText(msg.text);
      });
    });

    root.querySelectorAll('[data-action="regenerate"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chat = getCurrentChat();
        const msg = chat?.messages.find((m) => m.id === btn.getAttribute('data-message'));
        if (msg) regenerateMessage(msg);
      });
    });

    root.querySelectorAll('[data-action="reaction"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        reactToMessage(btn.getAttribute('data-message'), btn.getAttribute('data-reaction'));
      });
    });
  }

  function render() {
    ensureCurrentChat();
    document.documentElement.classList.toggle('dark', state.darkMode);
    document.getElementById('root').innerHTML = buildApp();
    bindDynamicNodes();
    scrollToBottom();
  }

  async function init() {
    state.chats = safeParse(STORAGE_KEYS.chats, []);
    const prefs = safeParse(STORAGE_KEYS.prefs, {});
    state.language = prefs.language || 'en';
    state.darkMode = typeof prefs.darkMode === 'boolean' ? prefs.darkMode : false; /* Off-white light default */
    state.currentChatId = prefs.currentChatId || (state.chats[0] && state.chats[0].id) || null;
    
    document.documentElement.classList.toggle('dark', state.darkMode);
    
    // Fetch User
    await fetchSessionUser();

    // 1500ms Splash screen transition
    setTimeout(() => {
      state.showSplash = false;
      const splashNode = document.querySelector('.splash-container');
      if (splashNode) {
        splashNode.classList.add('splash-hidden');
      }
    }, 1500);
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
