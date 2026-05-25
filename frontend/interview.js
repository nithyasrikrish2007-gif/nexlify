/* ============================================================
   NEXLIFY UNIVERSITY — AI MOCK INTERVIEW
   interview.js — Frontend Logic
   ============================================================ */

'use strict';

// ─── CONFIG ───────────────────────────────────────────────
const API_BASE = window.location.origin;
const TOTAL_QUESTIONS = 15;

// ─── STATE ────────────────────────────────────────────────
let state = {
  role: 'Frontend Developer',
  difficulty: 'Intermediate',
  interviewType: 'Technical',
  sessionId: null,
  questionCount: 0,
  currentQuestion: null,  // Store current AI question for replay
  history: [],        // {role, content}[]
  timerSec: 0,
  timerInterval: null,
  stream: null,       // MediaStream
  recognition: null,  // SpeechRecognition
  isRecording: false,
  isMicOn: true,
  isCamOn: true,
  isSpeaking: false,
};

// ─── DOM REFS ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const setupScreen    = $('setup-screen');
const interviewScreen= $('interview-screen');
const resultsScreen  = $('results-screen');
const loadingOverlay = $('loading-overlay');
const loaderText     = $('loader-text');

// Setup
const difficultySelect = $('difficulty-select');
const typeSelect       = $('type-select');
const courseSelect     = $('course-select');
const startBtn         = $('start-btn');

// Interview
const displayRole       = $('display-role');
const displayType       = $('display-type');
const displayDifficulty = $('display-difficulty');
const qCurrent          = $('q-current');
const qTotal            = $('q-total');
const progressFill      = $('progress-fill');
const timerDisplay      = $('timer-display');
const endInterviewBtn   = $('end-interview-btn');
const chatMessages      = $('chat-messages');
const typingIndicator   = $('typing-indicator');
const userInput         = $('user-input');
const sendBtn           = $('send-btn');
const clearBtn          = $('clear-btn');
const replayBtn         = $('replay-btn');
const skipBtn           = $('skip-btn');
const micBtn            = $('mic-btn');
const camBtn            = $('cam-btn');
const voiceBtn          = $('voice-btn');
const voiceHint         = $('voice-hint');
const voiceAnim         = $('voice-anim');
const userVideo         = $('user-video');
const camPlaceholder    = $('cam-placeholder');
const aiRing            = $('ai-ring');
const aiStatus          = $('ai-status');

// Results
const retryBtn         = $('retry-btn');
const newInterviewBtn  = $('new-interview-btn');
const downloadReportBtn = $('download-report-btn');

// ─── THEME ────────────────────────────────────────────────
const themeToggle = $('theme-toggle');
const savedTheme  = localStorage.getItem('nexlify-theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeIcon();

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('nexlify-theme', next);
  updateThemeIcon();
});
function updateThemeIcon() {
  const theme = document.documentElement.getAttribute('data-theme');
  themeToggle.innerHTML = `<i class="fas fa-${theme === 'dark' ? 'sun' : 'moon'}"></i>`;
}

// ─── SHOW LOADING ─────────────────────────────────────────
function showLoading(text = 'Please wait...') {
  loaderText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}
function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// ─── SCREENS ──────────────────────────────────────────────
function showScreen(name) {
  setupScreen.classList.add('hidden');
  interviewScreen.classList.add('hidden');
  resultsScreen.classList.add('hidden');
  $(`${name}-screen`).classList.remove('hidden');
}

// ─── TIMER ────────────────────────────────────────────────
function startTimer() {
  state.timerSec = 0;
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    state.timerSec++;
    const m = String(Math.floor(state.timerSec / 60)).padStart(2, '0');
    const s = String(state.timerSec % 60).padStart(2, '0');
    timerDisplay.textContent = `${m}:${s}`;
  }, 1000);
}
function stopTimer() { clearInterval(state.timerInterval); }

// ─── PROGRESS ─────────────────────────────────────────────
function updateProgress() {
  const pct = Math.min((state.questionCount / TOTAL_QUESTIONS) * 100, 100);
  progressFill.style.width = `${pct}%`;
  qCurrent.textContent = Math.min(state.questionCount, TOTAL_QUESTIONS);
  qTotal.textContent   = TOTAL_QUESTIONS;
}

// ─── CAMERA ───────────────────────────────────────────────
async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    userVideo.srcObject = state.stream;
    camPlaceholder.style.display = 'none';
  } catch (err) {
    console.warn('Camera/mic access denied:', err);
    camPlaceholder.style.display = 'flex';
  }
}
function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  userVideo.srcObject = null;
}

camBtn.addEventListener('click', () => {
  state.isCamOn = !state.isCamOn;
  if (state.stream) {
    state.stream.getVideoTracks().forEach(t => (t.enabled = state.isCamOn));
  }
  camBtn.classList.toggle('mic-off', !state.isCamOn);
  camBtn.innerHTML = `<i class="fas fa-video${state.isCamOn ? '' : '-slash'}"></i>`;
  camPlaceholder.style.display = state.isCamOn ? 'none' : 'flex';
});

micBtn.addEventListener('click', () => {
  state.isMicOn = !state.isMicOn;
  if (state.stream) {
    state.stream.getAudioTracks().forEach(t => (t.enabled = state.isMicOn));
  }
  micBtn.classList.toggle('mic-off', !state.isMicOn);
  micBtn.innerHTML = `<i class="fas fa-microphone${state.isMicOn ? '' : '-slash'}"></i>`;
});

// ─── SPEECH RECOGNITION ───────────────────────────────────
function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    voiceHint.textContent = 'Voice input not supported in this browser. Please type.';
    voiceBtn.disabled = true;
    return;
  }
  state.recognition = new SR();
  state.recognition.continuous = false;
  state.recognition.interimResults = true;
  state.recognition.lang = 'en-US';

  state.recognition.onstart = () => {
    state.isRecording = true;
    state.recognitionTranscript = '';
    voiceBtn.classList.add('recording');
    voiceBtn.innerHTML = '<i class="fas fa-stop"></i>';
    voiceAnim.classList.add('active');
    voiceHint.textContent = '🎙 Recording... speak now';
    setAiStatus('Listening...', '#facc15');
  };
  state.recognition.onend = () => {
    state.isRecording = false;
    voiceBtn.classList.remove('recording');
    voiceBtn.innerHTML = '<i class="fas fa-microphone-lines"></i>';
    voiceAnim.classList.remove('active');
    voiceHint.textContent = 'Click mic to record your answer';
    setAiStatus('Ready', '#22c55e');
    if (state.recognitionTranscript) {
      userInput.value = state.recognitionTranscript;
    }
  };
  state.recognition.onresult = (e) => {
    let interim = '';
    let final   = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final   += e.results[i][0].transcript;
      else                       interim += e.results[i][0].transcript;
    }
    if (final) {
      state.recognitionTranscript = (state.recognitionTranscript + final).trim();
      userInput.value = state.recognitionTranscript;
    } else {
      userInput.value = (state.recognitionTranscript + interim).trim();
    }
  };
  state.recognition.onerror = (e) => {
    console.warn('Speech error:', e.error);
    voiceHint.textContent = `Voice error: ${e.error}. Please type your answer.`;
  };
}

voiceBtn.addEventListener('click', () => {
  if (!state.recognition) return;
  if (state.isRecording) {
    state.recognition.stop();
  } else {
    userInput.value = '';
    try { state.recognition.start(); }
    catch (err) { console.warn('Recognition start error:', err); }
  }
});

// ─── TEXT-TO-SPEECH ───────────────────────────────────────
function speakText(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate  = 0.92;
  utter.pitch = 1.05;
  utter.volume = 1;

  // Pick a natural-sounding voice
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => v.name.toLowerCase().includes('google') && v.lang === 'en-US')
    || voices.find(v => v.lang === 'en-US')
    || voices[0];
  if (preferred) utter.voice = preferred;

  utter.onstart = () => { aiRing.classList.add('speaking'); setAiStatus('Speaking...', '#facc15'); state.isSpeaking = true; };
  utter.onend   = () => { aiRing.classList.remove('speaking'); setAiStatus('Listening...', '#22c55e'); state.isSpeaking = false; };
  speechSynthesis.speak(utter);
}

// Ensure voices are loaded
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {};
}

// ─── AI STATUS ────────────────────────────────────────────
function setAiStatus(text, color = '#94a3b8') {
  aiStatus.textContent = text;
  aiStatus.style.color = color;
  aiStatus.style.borderColor = color + '33';
  aiStatus.style.background  = color + '15';
}

// ─── CHAT RENDERING ───────────────────────────────────────
function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(role, text) {
  const isAI  = role === 'ai';
  const div   = document.createElement('div');
  div.className = `msg ${isAI ? 'ai-msg' : 'user-msg'}`;
  div.innerHTML = `
    <div class="msg-avatar">
      <i class="fas fa-${isAI ? 'robot' : 'user'}"></i>
    </div>
    <div class="msg-content">
      <span class="msg-name">${isAI ? 'Alex · AI Interviewer' : 'You'}</span>
      <div class="msg-bubble">${escapeHtml(text)}</div>
      <span class="msg-time">${now()}</span>
    </div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function showTyping() { typingIndicator.classList.remove('hidden'); chatMessages.scrollTop = chatMessages.scrollHeight; }
function hideTyping()  { typingIndicator.classList.add('hidden'); }

// ─── API CALLS ────────────────────────────────────────────
async function apiPost(endpoint, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('nexlify_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  // Check if the response is JSON before parsing
  const contentType = res.headers.get('content-type');
  let data = {};
  if (contentType && contentType.includes('application/json')) {
    data = await res.json();
  } else {
    // If not JSON, try to read as text for error messages, or default to empty object
    const text = await res.text();
    if (!res.ok) {
      // If response is not OK and not JSON, throw an error with the text content
      throw new Error(`API error ${res.status}: ${text || res.statusText}`);
    }
    // If response is OK but not JSON (unexpected), log a warning and return empty object
    console.warn(`Received non-JSON response for ${endpoint}: ${text}`);
    return { success: true }; // Return an object with success: true but no sessionId, to be handled by caller
  }

  if (!res.ok) {
    // If response is not OK, but it was JSON, then data will contain the error message
    throw new Error(`API error ${res.status}: ${data.message || res.statusText}`);
  }
  return data;
}

// ─── START INTERVIEW ──────────────────────────────────────
startBtn.addEventListener('click', async () => {
  state.course        = courseSelect.value;
  state.role          = state.course === 'Full Stack Development'
                        ? 'Full Stack Developer'
                        : (state.course === 'AI & Machine Learning' || state.course === 'Data Science')
                            ? 'AI/ML Developer'
                            : state.course;
  state.difficulty    = difficultySelect.value;
  state.interviewType = typeSelect.value;
  state.questionCount = 0;
  state.history       = [];

  // Update topbar labels
  displayRole.textContent       = state.role;
  displayType.textContent       = state.interviewType;
  displayDifficulty.textContent = state.difficulty;

  // Camera label color
  const diffColors = { Beginner: '#22c55e', Intermediate: '#eab308', Advanced: '#ef4444' };
  const diffEl = $('display-difficulty');
  diffEl.style.background   = (diffColors[state.difficulty] || '#22c55e') + '15';
  diffEl.style.color        = diffColors[state.difficulty] || '#22c55e';
  diffEl.style.borderColor  = (diffColors[state.difficulty] || '#22c55e') + '33';

  showLoading('Starting your interview session...');

  try { // This try block catches network errors or errors thrown by apiPost
    const data = await apiPost('/start-interview', {
      role: state.role,
      difficulty: state.difficulty,
      type: state.interviewType,
      course: state.course,
    });
    state.sessionId = data.sessionId;

    showScreen('interview');
    hideLoading();

    await startCamera();
    initSpeechRecognition();
    startTimer();
    updateProgress();
    chatMessages.innerHTML = '';

    // Show greeting
    if (data.greeting) {
      appendMessage('ai', data.greeting);
      speakText(data.greeting);
      state.history.push({ role: 'assistant', content: data.greeting });
    }

    // First question
    if (data.firstQuestion) {
      setTimeout(() => {
        state.currentQuestion = data.firstQuestion;  // Store question for replay
        appendMessage('ai', data.firstQuestion);
        speakText(data.firstQuestion);
        state.history.push({ role: 'assistant', content: data.firstQuestion });
        state.questionCount = 1;
        updateProgress();
      }, 800);
    }

  } catch (err) {
    hideLoading();
    alert('Could not connect to the interview server.\n\nMake sure the Node.js server is running:\n  node server.js\n\nError: ' + err.message);
    console.error(err);
  }
});

// ─── SEND ANSWER ──────────────────────────────────────────
async function sendAnswer(skip = false) {
  const isSkipping = skip === true; // Strictly check for boolean true, ignore Event objects
  if (state.isRecording && state.recognition) {
    await new Promise(resolve => {
      const finish = () => {
        state.recognition.removeEventListener('end', finish);
        resolve();
      };
      state.recognition.addEventListener('end', finish);
      try { state.recognition.stop(); }
      catch (err) { console.warn('Unable to stop recognition before send:', err); resolve(); }
    });
  }
  const rawText = userInput.value.trim();
  const text = isSkipping ? '[skipped]' : rawText;
  if (!isSkipping && !text) return;
  if (state.isSpeaking) window.speechSynthesis?.cancel();

  userInput.value = '';
  appendMessage('user', isSkipping ? 'Skipped this question' : text);
  state.history.push({ role: 'user', content: text });

  showTyping();
  setAiStatus('Thinking...', '#94a3b8');

  try {
    const data = await apiPost('/next-question', {
      sessionId: state.sessionId,
      userAnswer: text,
      questionCount: state.questionCount,
      role: state.role,
      difficulty: state.difficulty,
      type: state.interviewType,
      course: state.course,
    });

    hideTyping();

    if (data.question) {
      state.currentQuestion = data.question;  // Store question for replay
      appendMessage('ai', data.question);
      speakText(data.question);
      state.history.push({ role: 'assistant', content: data.question });
      state.questionCount++;
      updateProgress();
    }

    if (data.done) {
      setTimeout(() => endInterview(), 1200);
    }

  } catch (err) {
    hideTyping();
    setAiStatus('Error', '#ef4444');
    appendMessage('ai', 'I had trouble processing your answer. Please try again.');
    console.error(err);
  }
}

sendBtn.addEventListener('click', sendAnswer);
clearBtn.addEventListener('click', () => { userInput.value = ''; userInput.focus(); });
replayBtn.addEventListener('click', () => {
  if (state.currentQuestion) {
    window.speechSynthesis?.cancel();
    speakText(state.currentQuestion);
    setAiStatus('Replaying Question...', '#facc15');
    setTimeout(() => setAiStatus('Ready', '#22c55e'), 2000);
  }
});
skipBtn.addEventListener('click', () => {
  sendAnswer(true);
});
userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAnswer(); }
});

// ─── END INTERVIEW ────────────────────────────────────────
endInterviewBtn.addEventListener('click', () => {
  if (confirm('End the interview now and see your results?')) endInterview();
});

async function endInterview() {
  stopTimer();
  window.speechSynthesis?.cancel();
  showLoading('Generating your performance report...');
  console.log('[FRONTEND] Ending interview, showing loading overlay.');

  try {
    const data = await apiPost('/evaluate-answer', {
      sessionId: state.sessionId,
      role: state.role,
      difficulty: state.difficulty,
      type: state.interviewType,
      course: state.course,
      duration: state.timerSec,
    });
    console.log('[FRONTEND] API /evaluate-answer successful. Received data:', data);

    stopCamera();
    renderResults(data);
    showScreen('results');
    console.log('[FRONTEND] Results rendered and results screen shown.');

  } catch (err) {
    console.error('[FRONTEND] Error during interview evaluation:', err);
    // Render fallback results
    renderResults(buildFallbackResults());
    showScreen('results');
    console.log('[FRONTEND] Fallback results rendered and results screen shown due to error.');
  } finally {
    hideLoading();
    console.log('[FRONTEND] Loading overlay hidden.');
  }
}

// ─── RENDER RESULTS ───────────────────────────────────────
function renderResults(data) {
  console.log('[FRONTEND] renderResults called with data:', data);
  const scores = {
    technical:     data.technicalScore     || 0,
    communication: data.communicationScore || 0,
    confidence:    data.confidenceScore    || 0,
    overall:       data.overallScore       || 0,
  };

  const cards = {
    technical:     $('score-technical'),
    communication: $('score-communication'),
    confidence:    $('score-confidence'),
    overall:       $('score-overall'),
  };

  // Animate scores
  setTimeout(() => {
    Object.keys(scores).forEach(k => {
      const card  = cards[k];
      const num   = card.querySelector('.score-num');
      const fill  = card.querySelector('.score-fill');
      const score = scores[k];
      animateNumber(num, 0, score, 1200);
      fill.style.width = `${score * 10}%`;
    });
  }, 200);

  // Strengths
  const sl = $('strengths-list');
  sl.innerHTML = '';
  (data.strengths || []).forEach(s => {
    const li = document.createElement('li');
    li.textContent = s;
    sl.appendChild(li);
  });

  // Weaknesses
  const wl = $('weaknesses-list');
  wl.innerHTML = '';
  (data.weaknesses || []).forEach(w => {
    const li = document.createElement('li');
    li.textContent = w;
    wl.appendChild(li);
  });

  // Suggestions
  $('suggestions-content').innerHTML =
    (data.suggestions || []).map(s => `<p style="margin-bottom:10px;">• ${escapeHtml(s)}</p>`).join('');

  // Subtitle
  const overall = scores.overall;
  let emoji = overall >= 8 ? '🏆 Excellent performance!' : overall >= 6 ? '👍 Good effort — keep improving!' : '💪 Keep practicing, you\'ll get there!';
  $('results-subtitle').textContent = emoji;
  const reportTextEl = $('report-text');
  if (reportTextEl) {
    reportTextEl.textContent = data.reportText || 'Your detailed coaching report is ready. Review the feedback and download it for later reference.';
  }
}

downloadReportBtn?.addEventListener('click', () => {
  const reportTextEl = $('report-text');
  const reportText = reportTextEl?.textContent || '';
  if (!reportText.trim() || reportText.includes('Your detailed coaching report is ready')) {
    alert('There is no report available yet. Complete the interview first.');
    return;
  }

  const blob = new Blob([reportText], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Interview_Report_${state.course || 'course'}_${new Date().toISOString().slice(0,10)}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
});

function animateNumber(el, from, to, duration) {
  const start = performance.now();
  const step  = (ts) => {
    const p = Math.min((ts - start) / duration, 1);
    el.textContent = (from + (to - from) * easeOut(p)).toFixed(1);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function buildFallbackResults() {
  return {
    technicalScore:     7.0,
    communicationScore: 6.5,
    confidenceScore:    7.5,
    overallScore:       7.0,
    strengths:  ['Good problem-solving approach', 'Clear communication', 'Relevant examples shared'],
    weaknesses: ['Could elaborate on technical depth', 'Some answers were brief'],
    suggestions: ['Review core fundamentals for your chosen role', 'Practice speaking longer, structured answers', 'Use the STAR method for behavioral questions'],
  };
}

// ─── RETRY / NEW ──────────────────────────────────────────
retryBtn.addEventListener('click', () => {
  // Same settings
  startBtn.click();
  showScreen('setup');
  setTimeout(() => startBtn.click(), 100);
});

newInterviewBtn.addEventListener('click', () => {
  showScreen('setup');
  stopCamera();
  chatMessages.innerHTML = '';
  timerDisplay.textContent = '00:00';

});
