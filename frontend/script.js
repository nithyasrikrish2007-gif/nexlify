const API = window.location.origin; // This is correct, but ensure no trailing slashes in your fetch calls
const currentUser = JSON.parse(localStorage.getItem('nexlify_user') || '{}');
const ALLOWED_ENDPOINTS = [
    '/signup', '/login', '/enroll', '/contact', '/progress/complete', '/send-otp', '/verify-otp', 
    '/forgot-password', '/reset-password', '/send-password-otp', '/verify-password-otp',
    '/api/admin/messages', '/api/admin/stats', '/api/admin/notifications', '/api/admin/students',
    '/api/interview/start', '/api/interview/submit', '/api/interview/results', '/api/admin/interview-results',
    '/api/student/tasks', '/api/student/task-submit', '/api/student/task-results',
    '/api/admin/tasks', '/api/admin/task-submissions', '/api/admin/leaderboard',
    '/api/ai-interview/start', '/api/ai-interview/submit-answer', '/api/ai-interview/results', '/api/ai-interview/history',
    '/start-interview', '/next-question', '/evaluate-answer'
    , '/api/certificates/list', '/api/certificates/download'
];

let interviewSession = {
    interviewId: null,
    course: 'Full Stack Development',
    difficulty: 'Intermediate',
    questions: [],
    answers: [],
    currentQuestion: 0,
    sessionDbId: null,
    totalQuestions: 15, // Backend expects 15 questions
    timer: null,
    timeLeft: 60,
    mediaStream: null,
    recognition: null,
    recognitionIndex: null,
    recording: false,
    supportsSpeech: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    supportsMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
};

/* ── Live Chat Socket Setup ── */
const socket = typeof io !== 'undefined' ? io(API) : null;
if (socket) {
    socket.on('connect', () => {
        const user = JSON.parse(localStorage.getItem('nexlify_user') || '{}');
        const sid = localStorage.getItem('chat_session_id');
        if (sid && user.email) {
            socket.emit('user_join', { sessionId: sid, email: user.email, name: user.name });
        }
    });

    socket.on('receive_message', (data) => {
        // This function should be defined in your student dashboard/chat widget
        if (typeof window.appendChatMessage === 'function') {
            window.appendChatMessage(data);
        } else {
            console.log("New live message received:", data);
            // If we are on the dashboard, we might need to refresh the UI part only
            if (window.location.pathname.includes('dashboard.html')) {
                 // Logic to append message to chat window if open
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // Handle OAuth callback parameters
    const urlParams = new URLSearchParams(window.location.search);
    const oauthToken = urlParams.get('token');
    const oauthUser  = urlParams.get('user');

    if (oauthToken && oauthUser) {
        try {
            const userData = JSON.parse(decodeURIComponent(oauthUser));
            localStorage.setItem('nexlify_token', oauthToken);
            localStorage.setItem('nexlify_user', JSON.stringify(userData));
            localStorage.setItem('nexlify_logged_in', 'true');
            
            // Redirect to dashboard based on role
            const role = userData.role || 'student';
            window.location.href = role === 'admin' ? 'admin-dashboard.html' : 'dashboard.html';
            return; // Stop further initialization
        } catch (e) { console.error('OAuth data error:', e); }
    }

    const hamburger = document.querySelector('.hamburger');
    const navMenu   = document.querySelector('.nav-menu');

    if (hamburger && navMenu) {
        hamburger.addEventListener('click', () => {
            hamburger.classList.toggle('active');
            navMenu.classList.toggle('active');
        });
    }

    document.querySelectorAll('.nav-link').forEach(n => n.addEventListener('click', () => {
        hamburger?.classList.remove('active');
        navMenu?.classList.remove('active');
    }));

    window.addEventListener('scroll', () => {
        const navbar = document.querySelector('.navbar');
        if (!navbar) return;
        navbar.style.background = window.scrollY > 50 ? 'var(--nav-bg-scrolled)' : 'var(--nav-bg)';
        navbar.style.padding    = window.scrollY > 50 ? '0.5rem 0' : '1rem 0';
    });

    updateNavAuth();
    initHamburgerMenu(); // Call after updateNavAuth to ensure elements are present
    initTheme();
    animateStats();
    animateOnScroll();
    initFormEffects();
    initPhoneRestriction();
    initNameRestriction();
    initPasswordStrength();
    initSignupForm();
    initLoginForm();
    initForgotPasswordForm();
    initContactForm();
    initScrollIndicator();

    if (window.location.pathname.endsWith('dashboard.html')) {
        // loadLatestInterviewScore(); // This endpoint is not defined in the backend.
                                    // A new API endpoint would be needed to fetch user-specific latest interview score.
        loadStudentTasks();
        loadCertificates();
    }

    document.getElementById('enroll-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('enroll-modal')) closeEnroll();
    });

    window.addEventListener('offline', () => showToast('⚠️ You are offline. Some features may not work.', 'warning'));
    window.addEventListener('online',  () => showToast('✅ Back online!', 'success'));
});

// Function to initialize or re-initialize the hamburger menu listener
function initHamburgerMenu() {
    const hamburger = document.querySelector('.hamburger');
    const navMenu   = document.querySelector('.nav-menu');

    // Remove existing listeners to prevent duplicates if called multiple times
    if (hamburger) {
        const oldHamburger = hamburger.cloneNode(true);
        hamburger.parentNode.replaceChild(oldHamburger, hamburger);
        oldHamburger.addEventListener('click', () => {
            oldHamburger.classList.toggle('active');
            navMenu?.classList.toggle('active');
        });
    }
}

function initTheme() {
    const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', savedTheme);
    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) {
        toggleBtn.innerHTML = savedTheme === 'dark' ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
        // Clone to remove any previous listener
        const fresh = toggleBtn.cloneNode(true);
        toggleBtn.parentNode.replaceChild(fresh, toggleBtn);
        fresh.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            fresh.innerHTML = newTheme === 'dark' ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
        });
    }
}

function toggleEye(inputId, icon) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

function updateNavAuth() {
    const page = window.location.pathname.split('/').pop();
    if (page === 'login.html' || page === 'signup.html') return;

    const loggedIn    = localStorage.getItem('nexlify_logged_in') === 'true';
    const user        = JSON.parse(localStorage.getItem('nexlify_user') || '{}');
    const navButtons  = document.querySelector('.nav-buttons');
    const navAuthItems = document.querySelectorAll('.nav-auth');

    // Always keep theme toggle in nav-buttons
    const themeBtn = '<button id="theme-toggle" title="Toggle Dark/Light Mode"></button>';

    if (loggedIn && user.name) {
        const firstName = user.name.split(' ')[0];
        let btnHtml   = `<button class="nav-user-btn" onclick="openPanel()"><i class="fas fa-user-circle"></i> ${firstName}</button>`;

        if (navButtons) navButtons.innerHTML = themeBtn + btnHtml;
        navAuthItems.forEach(item => { item.innerHTML = ''; });
        if (navAuthItems[0]) navAuthItems[0].innerHTML = btnHtml;

        // Re-init theme toggle after innerHTML replacement
        initTheme();

        const panelName  = document.getElementById('panelName');
        const panelEmail = document.getElementById('panelEmail');
        const panelRole  = document.getElementById('panelRole');
        if (panelName)  panelName.textContent  = user.name;
        if (panelEmail) panelEmail.textContent = user.email || '';
        if (panelRole)  panelRole.textContent  = user.role || 'Student';

        // Point dashboard link to the correct page based on role
        const role = user.role || 'student';
        const dashUrl = role === 'admin' ? 'admin-dashboard.html'
                      : role === 'hr'    ? 'hr-dashboard.html'
                      : 'dashboard.html';
        const dashLink = document.querySelector('.panel-menu a[href*="dashboard"]');
        if (dashLink) dashLink.href = dashUrl;

        let lastActivity = Date.now();
        const SESSION_TIMEOUT = 30 * 60 * 1000;
        const WARNING_TIME    = 25 * 60 * 1000;

        ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => {
            document.addEventListener(evt, () => { lastActivity = Date.now(); }, true);
        });

        setInterval(() => {
            const idle = Date.now() - lastActivity;
            if (idle > SESSION_TIMEOUT) {
                localStorage.setItem('nexlify_logged_in', 'false');
                localStorage.removeItem('nexlify_user');
                showToast('⏰ Session expired. Please login again.', 'warning');
                setTimeout(() => { window.location.href = 'login.html'; }, 2000);
            } else if (idle > WARNING_TIME && idle < WARNING_TIME + 60000) {
                showToast('⚠️ Your session will expire in 5 minutes due to inactivity.', 'warning');
            }
        }, 60000);
    } else {
        if (navButtons) navButtons.innerHTML = `
            ${themeBtn}
            <a href="login.html" class="btn-login">Login</a>
            <a href="signup.html" class="btn-signup">Get Started</a>
        `;
        // Re-init theme toggle after innerHTML replacement
        initTheme();
        if (navAuthItems[0]) navAuthItems[0].innerHTML = `<a href="login.html" class="btn-login">Login</a>`;
        if (navAuthItems[1]) navAuthItems[1].innerHTML = `<a href="signup.html" class="btn-signup">Get Started</a>`;
    }
}

function openPanel() {
    document.getElementById('profilePanel')?.classList.add('open');
    document.getElementById('profileOverlay')?.classList.add('open');
}

function closePanel() {
    document.getElementById('profilePanel')?.classList.remove('open');
    document.getElementById('profileOverlay')?.classList.remove('open');
}

function logoutUser() {
    closePanel();
    localStorage.setItem('nexlify_logged_in', 'false');
    localStorage.removeItem('nexlify_user');
    localStorage.removeItem('nexlify_token');
    sessionStorage.clear();
    showToast('👋 Logged out successfully!');
    setTimeout(() => { window.location.href = 'home.html'; }, 1500);
}

function animateStats() {
    const stats = document.querySelectorAll('.stat-number');
    if (!stats.length) return;

    const animateNumber = (el) => {
        const target    = parseInt(el.getAttribute('data-target'));
        if (isNaN(target)) return;
        const increment = target / 100;
        let current     = 0;
        const timer = setInterval(() => {
            current += increment;
            if (current >= target) { el.textContent = target; clearInterval(timer); }
            else el.textContent = Math.floor(current);
        }, 30);
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) { animateNumber(entry.target); observer.unobserve(entry.target); }
        });
    });
    stats.forEach(stat => observer.observe(stat));
}

function animateOnScroll() {
    const elements = document.querySelectorAll('.feature-card, .mv-card, .placement-company, .story-content, .about-hero-content');
    if (!elements.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry, index) => {
            if (entry.isIntersecting) {
                setTimeout(() => {
                    entry.target.style.opacity   = '1';
                    entry.target.style.transform = 'translateY(0) scale(1)';
                }, index * 120);
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    elements.forEach(el => {
        el.style.opacity    = '0';
        el.style.transform  = 'translateY(40px) scale(0.97)';
        el.style.transition = 'all 0.7s cubic-bezier(0.25,0.46,0.45,0.94)';
        observer.observe(el);
    });
}

function initFormEffects() {
    document.querySelectorAll('.form-input, .enroll-input').forEach(input => {
        const group = input.closest('.form-group');
        input.addEventListener('focus', () => { group?.classList.add('focused'); });
        input.addEventListener('blur', () => {
            group?.classList.remove('focused');
            if (input.id !== 'confirmPassword') validateField(input);
        });
    });
}

function validateField(input) {
    const group = input.closest('.form-group');
    if (!group) return true;
    group.classList.remove('error', 'success');
    const val = input.value.trim();

    if (!val && input.required)                                                    { showFieldError(group, 'This field is required'); return false; }
    if (input.type === 'email' && val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { showFieldError(group, 'Enter a valid email address'); return false; }
    if (input.type === 'tel'   && val && !/^[0-9+\-\s()]{7,15}$/.test(val))       { showFieldError(group, 'Enter a valid phone number'); return false; }
    if (input.type === 'text'  && input.placeholder?.toLowerCase().includes('name') && val && !/^[a-zA-Z\s.'-]+$/.test(val)) {
        showFieldError(group, 'Name can only contain letters'); return false;
    }
    if (input.type === 'password' && input.id !== 'confirmPassword' && val && val.length < 6) {
        showFieldError(group, 'Password must be at least 6 characters'); return false;
    }

    group.classList.add('success');
    removeFieldError(group);
    return true;
}

function showFieldError(group, msg) {
    group.classList.add('error');
    let err = group.querySelector('.field-error');
    if (!err) { err = document.createElement('span'); err.className = 'field-error'; group.appendChild(err); }
    err.textContent = msg;
}

function removeFieldError(group) {
    group.querySelector('.field-error')?.remove();
}

function initPhoneRestriction() {
    document.querySelectorAll('input[type="tel"]').forEach(input => {
        input.addEventListener('keypress', (e) => { if (!/[\d+\-\s()]/.test(e.key)) e.preventDefault(); });
        input.addEventListener('input',    () => { input.value = input.value.replace(/[^0-9+\-\s()]/g, ''); });
    });
}

function initNameRestriction() {
    document.querySelectorAll('input[type="text"]').forEach(input => {
        if (input.placeholder?.toLowerCase().includes('name')) {
            input.addEventListener('keypress', (e) => { if (!/[a-zA-Z\s.'-]/.test(e.key)) e.preventDefault(); });
        }
    });
}

function initPasswordStrength() {
    const pwd = document.getElementById('signupPassword');
    if (!pwd) return;

    const bar = document.createElement('div');
    bar.innerHTML = `
        <div id="pwd-strength-bar" style="height:4px;border-radius:4px;margin-top:6px;transition:all 0.3s;width:0;background:#ef4444;"></div>
        <div id="pwd-strength-text" style="font-size:0.75rem;margin-top:4px;color:#64748b;"></div>
    `;
    pwd.closest('.form-group')?.appendChild(bar);

    pwd.addEventListener('input', () => {
        const v = pwd.value;
        let score = 0;
        if (v.length >= 8)          score++;
        if (/[A-Z]/.test(v))        score++;
        if (/[0-9]/.test(v))        score++;
        if (/[^A-Za-z0-9]/.test(v)) score++;

        const b = document.getElementById('pwd-strength-bar');
        const t = document.getElementById('pwd-strength-text');
        if (!b || !t) return;

        const levels = [
            { w:'25%', c:'#ef4444', label:'Weak'   },
            { w:'50%', c:'#f97316', label:'Fair'   },
            { w:'75%', c:'#facc15', label:'Good'   },
            { w:'100%',c:'#10b981', label:'Strong' }
        ];
        const lvl = levels[Math.max(0, score - 1)] || levels[0];
        b.style.width      = v.length ? lvl.w : '0';
        b.style.background = lvl.c;
        t.textContent      = v.length ? `Password strength: ${lvl.label}` : '';
        t.style.color      = lvl.c;
    });
}

function showToast(msg, type = 'success') {
    let toast = document.getElementById('nexlify-toast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'nexlify-toast'; document.body.appendChild(toast); }
    toast.className = `nexlify-toast ${type}`;
    toast.innerHTML = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function openInterviewModal(resume = false) {
    const modal = document.getElementById('interviewModal');
    if (!modal) return;
    modal.style.display = 'flex';
    if (!resume) resetInterview();
}

function closeInterviewModal() {
    stopInterviewMedia();
    const modal = document.getElementById('interviewModal');
    if (!modal) return;
    modal.style.display = 'none';
}

function resetInterview() {
    const courseKeys = Object.keys(COURSE_LESSONS);
    const defaultCourse = courseKeys.includes(currentUser.course) ? currentUser.course : courseKeys[0] || 'Full Stack Development';
    interviewSession = {
        interviewId: null,
        course: defaultCourse,
        questions: [],
        answers: [],
        currentQuestion: 0,
        mediaStream: null,
        recognition: null,
        recognitionIndex: null,
        recording: false,
        supportsSpeech: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
        supportsMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    };

    const courseSelect = document.getElementById('im-course-select');
    if (courseSelect) {
        courseSelect.innerHTML = courseKeys.map(course => `<option value="${escapeHtml(course)}">${escapeHtml(course)}</option>`).join('');
        courseSelect.value = interviewSession.course;
    }

    const introEl = document.getElementById('im-intro');
    if (introEl) introEl.classList.remove('hidden');
    const questionsEl = document.getElementById('im-questions');
    if (questionsEl) questionsEl.classList.add('hidden');
    const resultEl = document.getElementById('im-result');
    if (resultEl) resultEl.classList.add('hidden');

    const progressEl = document.getElementById('im-progress-label');
    if (progressEl) progressEl.textContent = 'Question 1 of 4';
    const timerEl = document.getElementById('im-timer-label');
    if (timerEl) timerEl.textContent = '⏱️ 60s';

    const questionsListEl = document.getElementById('im-questions-list');
    if (questionsListEl) questionsListEl.replaceChildren();
    const resultSummaryEl = document.getElementById('im-result-summary');
    if (resultSummaryEl) resultSummaryEl.replaceChildren();
    const mediaPanelEl = document.getElementById('im-media-panel');
    if (mediaPanelEl) mediaPanelEl.classList.add('hidden');
    const cameraStatusEl = document.getElementById('im-camera-status');
    if (cameraStatusEl) cameraStatusEl.textContent = 'Camera: Off';
    const micStatusEl = document.getElementById('im-mic-status');
    if (micStatusEl) micStatusEl.textContent = 'Mic: Off';
    const videoPreviewEl = document.getElementById('im-video-preview');
    if (videoPreviewEl) videoPreviewEl.removeAttribute('srcObject');
    const startBtn = document.getElementById('im-start-btn');
    if (startBtn) startBtn.removeAttribute('disabled');
    if (startBtn) startBtn.textContent = 'Start Live Interview';
}

async function prepareInterviewMedia() {
    if (!interviewSession.supportsMedia) {
        showToast('Your browser cannot access camera and microphone.', 'warning');
        return false;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        interviewSession.mediaStream = stream;
        const videoEl = document.getElementById('im-video-preview');
        if (videoEl) {
            videoEl.srcObject = stream;
            videoEl.muted = true;
        }
        updateInterviewMediaStatus();
        document.getElementById('im-media-panel')?.classList.remove('hidden');
        return true;
    } catch (err) {
        console.error('Interview media error:', err);
        showToast('Please allow camera and microphone to attend the interview.', 'error');
        return false;
    }
}

function updateInterviewMediaStatus() {
    const cameraStatus = document.getElementById('im-camera-status');
    const micStatus = document.getElementById('im-mic-status');
    const stream = interviewSession.mediaStream;
    const hasVideo = stream?.getVideoTracks()?.length > 0;
    const hasAudio = stream?.getAudioTracks()?.length > 0;
    if (cameraStatus) cameraStatus.textContent = hasVideo ? `Camera: ${stream.getVideoTracks()[0].enabled ? 'On' : 'Off'}` : 'Camera: Off';
    if (micStatus) micStatus.textContent = hasAudio ? `Mic: ${stream.getAudioTracks()[0].enabled ? 'On' : 'Off'}` : 'Mic: Off';
}

function stopInterviewMedia() {
    if (interviewSession.recognition) {
        try { interviewSession.recognition.stop(); } catch (err) { }
        interviewSession.recognition = null;
        interviewSession.recording = false;
        interviewSession.recognitionIndex = null;
    }
    if (interviewSession.mediaStream) {
        interviewSession.mediaStream.getTracks().forEach(track => track.stop());
        interviewSession.mediaStream = null;
    }
    const videoEl = document.getElementById('im-video-preview');
    if (videoEl) videoEl.srcObject = null;
    updateInterviewMediaStatus();
}

async function speakText(text, animate = false) {
    if (!text) return;
    
    if (animate) {
        const container = document.getElementById('im-questions-list');
        const activeCard = container.querySelector('.im-question-card.active p');
        if (activeCard) {
            activeCard.innerHTML = '<span class="ai-typing">AI is thinking...</span>';
            await new Promise(r => setTimeout(r, 800)); // Simulate thinking
            activeCard.textContent = '';
            for (let i = 0; i < text.length; i++) {
                activeCard.textContent += text[i];
                if (i % 3 === 0) await new Promise(r => setTimeout(r, 10)); // Typing speed
            }
        }
    }

    if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US';
        utterance.rate = 0.95;
        window.speechSynthesis.speak(utterance);
    }
}

async function startInterview() {
    const role = document.getElementById('im-course-select')?.value || 'Full Stack Development';
    const startBtn = document.getElementById('im-start-btn');
    
    interviewSession.course = role;
    interviewSession.difficulty = 'Intermediate'; 
    interviewSession.currentQuestion = 1;

    if (startBtn) {
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing Interview...';
    }

    const canUseMedia = await prepareInterviewMedia();
    if (!canUseMedia) {
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.textContent = 'Start Live Interview';
        }
        return;
    }

    const result = await apiCall('/start-interview', {
        role: interviewSession.course, 
        difficulty: interviewSession.difficulty 
    });

    if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = 'Start Live Interview';
    }

    if (result.success) {
        interviewSession.interviewId = result.sessionId;
        interviewSession.sessionDbId = result.sessionDbId; // This is the DB ID for ai_interview_sessions
        interviewSession.questions = [{ question: result.question }];
        
        document.getElementById('im-intro')?.classList.add('hidden');
        document.getElementById('im-questions')?.classList.remove('hidden');
        
        renderInterviewQuestions();
        speakQuestion(0);
        startQuestionTimer();
    } else {
        showToast(result.message || 'Failed to start AI interview', 'error');
    }
}

function startQuestionTimer() {
    if (interviewSession.timer) clearInterval(interviewSession.timer);
    interviewSession.timeLeft = 60;
    const timerEl = document.getElementById('im-timer-label');
    
    interviewSession.timer = setInterval(() => {
        interviewSession.timeLeft--;
        if (timerEl) timerEl.textContent = `⏱️ ${interviewSession.timeLeft}s`;
        
        if (interviewSession.timeLeft <= 0) {
            clearInterval(interviewSession.timer);
            submitInterview();
        }
    }, 1000);
}

function speakQuestion(index, animate = false) {
    interviewSession.currentQuestion = index;
    const question = interviewSession.questions[index];
    if (!question) return;
    speakText(question.question, animate);
    document.querySelectorAll('.im-question-card').forEach((card, idx) => {
        card.classList.toggle('active', idx === index);
    });

    const progressEl = document.getElementById('im-progress-label');
    if (progressEl) progressEl.textContent = `Question ${index + 1} of ${interviewSession.questions.length}`;
    const timerEl = document.getElementById('im-timer-label');
    if (timerEl) timerEl.textContent = '⏱️ 60s';
    startQuestionTimer(); // Restart timer for new question
}


function createSpeechRecognition(index) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return null;

    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
            transcript += event.results[i][0].transcript;
        }
        const textarea = document.getElementById(`im-answer-${index}`);
        if (textarea) {
            textarea.value = transcript;
            interviewSession.answers[index] = transcript;
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error', event.error);
        showToast(`Speech recognition error: ${event.error}`, 'error');
        interviewSession.recording = false;
        updateRecordingButton(index);
    };

    recognition.onend = () => {
        interviewSession.recording = false;
        updateRecordingButton(index);
    };

    return recognition;
}

function toggleRecording(index) {
    const recordBtn = document.getElementById(`im-record-btn-${index}`);
    if (!interviewSession.supportsSpeech) {
        showToast('Speech recognition is not supported in this browser.', 'warning');
        return;
    }

    if (interviewSession.recording && interviewSession.recognitionIndex === index) {
        stopSpeechRecognition();
        return;
    }

    stopSpeechRecognition();
    const recognition = createSpeechRecognition(index);
    if (!recognition) {
        showToast('Speech recognition is unavailable.', 'warning');
        return;
    }

    interviewSession.recognition = recognition;
    interviewSession.recognitionIndex = index;
    interviewSession.recording = true;
    recognition.start();
    updateRecordingButton(index);
}

function stopSpeechRecognition() {
    if (interviewSession.recognition) {
        try { interviewSession.recognition.stop(); } catch (err) { }
        interviewSession.recognition = null;
    }
    interviewSession.recording = false;
    interviewSession.recognitionIndex = null;
    document.querySelectorAll('[id^="im-record-btn-"]').forEach(btn => {
        btn.textContent = 'Start Recording';
    });
}

function updateRecordingButton(index) {
    document.querySelectorAll('[id^="im-record-btn-"]').forEach(btn => {
        const btnIndex = Number(btn.id.replace('im-record-btn-', ''));
        if (btnIndex === index && interviewSession.recording) {
            btn.textContent = 'Stop Recording';
        } else {
            btn.textContent = 'Start Recording';
        }
    });
}

function renderInterviewQuestions() {
    const container = document.getElementById('im-questions-list');
    if (!container) return;
    container.innerHTML = interviewSession.questions.map((item, index) => `
        <div class="im-question-card${index === 0 ? ' active' : ''}">
            <div class="im-question-actions">
                <h4 style="margin:0;color:#f8fafc;">Question ${index + 1}</h4>
                <button class="btn-primary" type="button" onclick="speakQuestion(${index})" style="padding:0.65rem 1rem;font-size:0.84rem;">Listen</button>
                <button id="im-record-btn-${index}" class="btn-primary" type="button" onclick="toggleRecording(${index})" style="padding:0.65rem 1rem;font-size:0.84rem;">${interviewSession.supportsSpeech ? 'Start Recording' : 'Speech Unavailable'}</button>
            </div>
            <p style="margin-bottom:10px;color:#cbd5e1;font-size:0.95rem;">${escapeHtml(item.question)}</p>
            <textarea id="im-answer-${index}" rows="5" placeholder="Speak or type your answer here..." style="width:100%;border-radius:16px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:#f8fafc;padding:14px;font-family:Inter,sans-serif;font-size:0.95rem;resize:vertical;"></textarea>
            <div style="margin-top:10px;color:#94a3b8;font-size:0.85rem;">${interviewSession.supportsSpeech ? 'Speak your response using the microphone, then stop recording.' : 'Your browser does not support speech recognition. Please type your answer.'}</div>
        </div>
    `).join('');
}

async function submitInterview() {
    const btn = document.getElementById('im-submit-btn');
    const idx = interviewSession.currentQuestion;
    const textarea = document.getElementById(`im-answer-${idx}`);
    const answerText = textarea ? textarea.value.trim() : '';

    if (!answerText && interviewSession.timeLeft > 0) {
        showToast('Please answer the current question before submitting.', 'warning');
        return;
    }

    if (interviewSession.timer) clearInterval(interviewSession.timer);
    stopSpeechRecognition();

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-brain fa-spin"></i> AI Evaluation...';

    const result = await apiCall('/next-question', {
        sessionId: interviewSession.interviewId, // Use sessionId from backend
        userAnswer: answerText || "No answer provided.",
        questionCount: idx + 1, // Current question number
        role: interviewSession.course, difficulty: interviewSession.difficulty, type: 'Technical', course: interviewSession.course
    });

    btn.disabled = false;
    btn.textContent = 'Submit Answer';

    if (!result.success) {
        showToast(result.message || 'Submission failed.', 'error');
        return;
    }

    if (result.success) {
        if (result.isComplete) {
            // Call the correct evaluation endpoint
            const finalRes = await apiCall('/evaluate-answer', {
                sessionId: interviewSession.interviewId,
                role: interviewSession.course,
                difficulty: interviewSession.difficulty,
                type: 'Technical',
                course: interviewSession.course
            });
            showInterviewResult(finalRes);
        } else {
            interviewSession.questions.push({ question: result.nextQuestion });
            renderInterviewQuestions();
            speakQuestion(idx + 1, true);
            startQuestionTimer();
            showToast(`Score: ${result.currentScore}/10 - ${result.currentFeedback}`, 'info');
        }
    }
}

function downloadInterviewPDF() {
    const content = document.getElementById('im-result-summary').innerHTML;
    const win = window.open('', '_blank');
    win.document.write(`<html><head><title>Interview Report</title><link rel="stylesheet" href="style.css"></head><body style="padding:40px; background:#fff; color:#000;">${content}</body></html>`);
    win.document.close();
    setTimeout(() => { win.print(); }, 500);
}


function showInterviewResult(result) {
    const resultPanel = document.getElementById('im-result');
    const summary = document.getElementById('im-result-summary');
    const questionsArea = document.getElementById('im-questions');
    if (!resultPanel || !summary) return;
    
    // The /evaluate-answer endpoint returns different data structure
    const overallScore = result.overallScore || 0;
    const reportText = result.reportText || 'No detailed report available.';
    const strengths = Array.isArray(result.strengths) ? result.strengths.map(s => `<li>${escapeHtml(s)}</li>`).join('') : '';
    const weaknesses = Array.isArray(result.weaknesses) ? result.weaknesses.map(w => `<li>${escapeHtml(w)}</li>`).join('') : '';
    const suggestions = Array.isArray(result.suggestions) ? result.suggestions.map(s => `<li>${escapeHtml(s)}</li>`).join('') : '';

    // Fetch detailed QA from backend if needed, or adapt this to use the reportText
    // For now, we'll display the summary from the new /evaluate-answer endpoint
    summary.innerHTML = `
        <div style="margin-bottom:1rem;"><span style="display:inline-flex;gap:8px;align-items:center;font-weight:700;color:#facc15;font-size:0.95rem;"><i class="fas fa-robot"></i> Interview Summary</span></div>
        <div style="font-size:2rem;font-weight:800;color:#fff;">Overall Score: ${escapeHtml(String(overallScore))}/10</div>
        <div style="margin:10px 0;color:#94a3b8;">${escapeHtml(reportText)}</div>
        
        <div style="margin-top:20px;">
            <h4 style="color:#facc15;margin-bottom:10px;">Strengths:</h4>
            <ul style="list-style:none;padding:0;margin:0;color:#cbd5e1;">${strengths}</ul>
        </div>
        <div style="margin-top:20px;">
            <h4 style="color:#facc15;margin-bottom:10px;">Areas for Improvement:</h4>
            <ul style="list-style:none;padding:0;margin:0;color:#cbd5e1;">${weaknesses}</ul>
        </div>
        <div style="margin-top:20px;">
            <h4 style="color:#facc15;margin-bottom:10px;">Recommendations:</h4>
            <ul style="list-style:none;padding:0;margin:0;color:#cbd5e1;">${suggestions}</ul>
        </div>
    `;

    questionsArea.classList.add('hidden');
    resultPanel.classList.remove('hidden');
}

// This function is currently calling a non-existent endpoint.
// To make it work, a new backend API endpoint would be needed to fetch
// the latest interview score for the authenticated user.
// For now, it's commented out to prevent errors.
async function loadLatestInterviewScore() {
    console.warn("loadLatestInterviewScore is currently disabled as its backend endpoint is not defined.");
    // const result = await apiCall('/api/interview/results'); // This endpoint does not exist in server.js
    // if (!result.success) return;
    // const latest = Array.isArray(result.results) ? result.results[0] : null;
    // const scoreEl = document.getElementById('latestInterviewScore');
    // const statEl = document.getElementById('statInterviewScore');
    // const text = latest ? `${latest.score}%` : 'No attempts yet';
    // if (scoreEl) scoreEl.textContent = text;
    // if (statEl) statEl.textContent = text;
}

async function loadCertificates() {
    const user = JSON.parse(localStorage.getItem('nexlify_user') || '{}');
    if (!user.email) return;

    const res = await apiCall(`/api/certificates/list/${user.email}`);
    if (res.success && res.certificates.length > 0) {
        const container = document.getElementById('certificates-container');
        if (!container) return;
        
        container.innerHTML = res.certificates.map(course => `
            <div class="cert-card" style="background:var(--card-bg); border:1px solid var(--border-color); padding:20px; border-radius:15px; display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <div>
                    <h4 style="color:#D4AF37; margin:0;">${course}</h4>
                    <p style="color:#94a3b8; font-size:0.8rem; margin:5px 0 0 0;">Course Fully Completed</p>
                </div>
                <button class="btn-primary" onclick="viewCertificate('${course}')" style="background:linear-gradient(135deg,#D4AF37,#AF8A2C); color:#000;">
                    <i class="fas fa-certificate"></i> Generate Certificate
                </button>
            </div>
        `).join('');
    }
}

async function viewCertificate(course) {
    const user = JSON.parse(localStorage.getItem('nexlify_user') || '{}');
    showToast('📜 Generating your certificate...', 'info');
    
    const token = localStorage.getItem('nexlify_token');
    const response = await fetch(`${API}/api/certificates/download/${user.email}/${encodeURIComponent(course)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (response.ok) {
        const svgText = await response.text();
        const blob = new Blob([svgText], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        
        // Open in a new tab for Printing/Saving
        const win = window.open('', '_blank');
        win.document.write(`
            <html>
                <head><title>Certificate - ${course}</title></head>
                <body style="margin:0; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#0f172a; font-family:sans-serif;">
                    <img src="${url}" style="max-width:90%; box-shadow:0 0 50px rgba(0,0,0,0.5); border:1px solid #D4AF37;">
                    <div style="margin-top:20px;">
                        <button onclick="window.print()" style="padding:10px 25px; cursor:pointer; background:#D4AF37; border:none; border-radius:5px; font-weight:bold;">Download / Print as PDF</button>
                        <button onclick="window.close()" style="padding:10px 25px; cursor:pointer; background:#334155; color:white; border:none; border-radius:5px; margin-left:10px;">Close</button>
                    </div>
                </body>
            </html>
        `);
    } else {
        const errorData = await response.json().catch(() => ({}));
        showToast(`❌ ${errorData.message || 'Failed to generate certificate'}`, 'error');
    }
}

async function loadStudentTasks() {
    const container = document.getElementById('studentTasksContainer');
    if (!container) return;
    container.innerHTML = '<div class="empty" style="padding:1rem;"><i class="fas fa-spinner fa-spin"></i> Loading tasks…</div>';
    const result = await apiCall('/api/student/tasks');
    if (!result.success) {
        container.innerHTML = `<div class="empty" style="padding:1rem;color:#f87171;"><i class="fas fa-exclamation-circle"></i> ${escapeHtml(result.message || 'Unable to load interview tasks.')}</div>`;
        return;
    }
    renderStudentTasks(Array.isArray(result.tasks) ? result.tasks : []);
}

function renderStudentTasks(tasks) {
    const container = document.getElementById('studentTasksContainer');
    if (!container) return;
    if (!Array.isArray(tasks) || tasks.length === 0) {
        container.innerHTML = `
            <div class="empty" style="padding:1rem;">
                <i class="fas fa-tasks"></i>
                <p>No tasks are assigned yet. Complete a mock interview to receive tasks based on your course.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = tasks.map(task => {
        const status = task.submission_status || 'pending';
        const statusLabel = status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : status === 'submitted' ? 'Submitted' : 'Pending';
        const existingAnswer = escapeHtml(task.answer || '');
        return `
            <div class="task-card" style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:20px;padding:1.4rem;margin-bottom:1rem;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
                    <div>
                        <div style="font-size:1rem;font-weight:700;color:#facc15;">${escapeHtml(task.title)}</div>
                        <div style="margin-top:0.45rem;color:var(--text-secondary);font-size:0.92rem;">Course: ${escapeHtml(task.course)} • Due: ${escapeHtml(task.due_date || 'No deadline')}</div>
                    </div>
                    <div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;">
                        <span style="padding:0.45rem 0.85rem;border-radius:999px;background:var(--border-color);font-size:0.78rem;">${statusLabel}</span>
                    </div>
                </div>
                <p style="margin:1rem 0 0.8rem;color:var(--text-primary);line-height:1.7;">${escapeHtml(task.description || 'No description provided.')}</p>
                <textarea id="task-answer-${task.id}" rows="4" placeholder="Write your submission here..." style="width:100%;border-radius:16px;border:1px solid var(--border-color);background:var(--bg-primary);color:var(--text-primary);padding:14px;font-family:Inter,sans-serif;font-size:0.95rem;resize:vertical;">${existingAnswer}</textarea>
                <div style="display:flex;justify-content:flex-end;gap:0.85rem;margin-top:0.85rem;flex-wrap:wrap;">
                    <button class="btn btn-outline" onclick="loadStudentTasks()" style="padding:0.75rem 1.1rem;">Refresh</button>
                    <button class="btn-primary" onclick="submitTask(${task.id})" style="padding:0.75rem 1.1rem;">Submit Task</button>
                </div>
            </div>
        `;
    }).join('');
}

async function submitTask(taskId) {
    const textarea = document.getElementById(`task-answer-${taskId}`);
    if (!textarea) return;
    const answer = textarea.value.trim();
    if (!answer) { showToast('Please provide your submission before sending.', 'warning'); return; }

    const result = await apiCall('/api/student/task-submit', { taskId, answer });
    if (!result.success) {
        showToast(result.message || 'Unable to submit the task.', 'error');
        return;
    }
    showToast(result.message || 'Task submitted for review.', 'success');
    loadStudentTasks();
}

async function resetInterviewAndOpen() {
    resetInterview();
    openInterviewModal();
}

async function apiCall(endpoint, body = null, method = 'GET') {
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    if (!ALLOWED_ENDPOINTS.includes(path))
        return { success: false, message: 'Invalid request endpoint.' };
    
    const token = localStorage.getItem('nexlify_token');
    try {
        const res = await fetch(`${API}${path}`, {
            method  : body ? 'POST' : method, // Default to POST if body exists, otherwise use provided method
            headers : { 
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : ''
            },
            body    : body ? JSON.stringify(body) : null
        });

        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
            return await res.json();
        }
        return { success: false, message: `Server error: ${res.statusText}` };
    } catch {
        return { success: false, message: '❌ Cannot connect to server! Make sure Node.js is running.' };
    }
}

function showOtpModal(email) {
    let modal = document.getElementById('otp-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'otp-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(5px);z-index:99999;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `
            <div style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:20px;padding:40px;width:420px;max-width:95%;text-align:center;">
                <i class="fas fa-envelope-open-text" style="font-size:2.5rem;color:#facc15;margin-bottom:1rem;display:block;"></i>
                <h3 style="color:var(--text-primary);margin-bottom:0.5rem;">Verify Your Email</h3>
                <p style="color:var(--text-secondary);font-size:0.9rem;margin-bottom:1.5rem;">Enter the 6-digit code sent to <strong style="color:#facc15;">${email}</strong></p>
                <input id="otp-input" type="text" maxlength="6" placeholder="Enter OTP"
                    style="width:100%;padding:14px;text-align:center;font-size:1.5rem;letter-spacing:8px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:12px;color:var(--text-primary);font-family:Inter,sans-serif;margin-bottom:1rem;">
                <button id="otp-verify-btn" onclick="verifyOtp('${email}')"
                    style="width:100%;padding:14px;background:linear-gradient(135deg,#facc15,#eab308);color:#1e293b;font-weight:700;font-size:1rem;border:none;border-radius:50px;cursor:pointer;font-family:Inter,sans-serif;margin-bottom:0.8rem;">
                    Verify & Create Account
                </button>
                <button onclick="resendOtp('${email}')"
                    style="background:none;border:none;color:var(--text-secondary);font-size:0.85rem;cursor:pointer;font-family:Inter,sans-serif;">
                    Resend OTP
                </button>
            </div>
        `;
        document.body.appendChild(modal);
    } else {
        modal.style.display = 'flex';
    }
}

window.verifyOtp = async function(email) {
    const otp = document.getElementById('otp-input').value.trim();
    if (otp.length !== 6) { showToast('⚠️ Enter the 6-digit OTP.', 'warning'); return; }

    const btn = document.getElementById('otp-verify-btn');
    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';

    const result = await apiCall('/verify-otp', { email, otp });
    btn.disabled  = false;
    btn.innerHTML = 'Verify & Create Account';

    if (result.success) {
        document.getElementById('otp-modal').style.display = 'none';
        showToast('🎓 ' + result.message);
        // Auto-login after successful signup
        const form     = document.getElementById('signupForm');
        const emailVal = form.querySelector('input[type="email"]').value.trim();
        const pwdVal   = document.getElementById('signupPassword').value;
        setTimeout(async () => {
            const loginRes = await apiCall('/login', { email: emailVal, password: pwdVal });
            if (loginRes.success) {
                localStorage.setItem('nexlify_user', JSON.stringify(loginRes.user));
                localStorage.setItem('nexlify_logged_in', 'true');
                localStorage.setItem('nexlify_token', loginRes.token);
                sessionStorage.setItem('token',     loginRes.token);
                sessionStorage.setItem('userRole',  loginRes.user.role);
                sessionStorage.setItem('userName',  loginRes.user.name);
                sessionStorage.setItem('userEmail', loginRes.user.email);
                
                const role = (loginRes.user.role || 'student').toLowerCase();
                if (role === 'admin')    window.location.href = 'admin-dashboard.html';
                else if (role === 'hr')  window.location.href = 'hr-dashboard.html';
                else                     window.location.href = 'dashboard.html';
            } else {
                window.location.href = 'login.html';
            }
        }, 1500);
    } else {
        showToast('❌ ' + result.message, 'error');
    }
};

window.resendOtp = async function(email) {
    const form     = document.getElementById('signupForm');
    const name     = form.querySelector('input[type="text"]').value.trim();
    const phone    = form.querySelector('input[type="tel"]').value.trim();
    const password = document.getElementById('signupPassword').value;
    const role     = document.getElementById('roleSelect').value;

    showToast('⏳ Resending OTP...');
    const result = await apiCall('/send-otp', { name, email, phone, password, role });
    if (result.success) showToast('📧 OTP resent to your email!');
    else showToast('❌ ' + result.message, 'error');
};

function initSignupForm() {
    const form = document.getElementById('signupForm');
    if (!form) return;
    if (localStorage.getItem('nexlify_logged_in') === 'true') { window.location.href = 'home.html'; return; }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let valid = true;
        form.querySelectorAll('input[required], select[required]').forEach(input => {
            if (input.id !== 'confirmPassword' && !validateField(input)) valid = false;
        });
        if (!valid) return;

        const password = document.getElementById('signupPassword');
        const confirm  = document.getElementById('confirmPassword');
        if (!confirm.value.trim()) {
            const g = confirm.closest('.form-group');
            showFieldError(g, 'Please confirm your password'); g.classList.add('error'); return;
        }
        if (password.value !== confirm.value) {
            const g = confirm.closest('.form-group');
            showFieldError(g, 'Passwords do not match'); g.classList.add('error'); return;
        }

        const name  = form.querySelector('input[type="text"]').value.trim();
        const email = form.querySelector('input[type="email"]').value.trim();
        const phone = form.querySelector('input[type="tel"]').value.trim();
        const role  = document.getElementById('roleSelect').value;

        const btn      = form.querySelector('button[type="submit"]');
        const origText = btn.innerHTML;
        btn.disabled   = true;
        btn.innerHTML  = '<i class="fas fa-spinner fa-spin"></i> Sending OTP...';

        showToast('📧 Sending verification code...');
        const result = await apiCall('/send-otp', { name, email, phone, password: password.value, role });

        btn.disabled  = false;
        btn.innerHTML = origText;

        if (result.success) {
            showToast('📧 OTP sent! Check your email.');
            showOtpModal(email);
        } else {
            showToast('❌ ' + result.message, 'error');
            if (result.message.includes('already registered')) {
                const emailInput = form.querySelector('input[type="email"]');
                const emailGroup = emailInput?.closest('.form-group');
                if (emailGroup) showFieldError(emailGroup, 'This email is already registered!');
                setTimeout(() => { window.location.href = 'login.html'; }, 2500);
            }
        }
    });
}

function initLoginForm() {
    const form = document.getElementById('loginForm');
    if (!form) return;

    if (typeof generateCaptcha === 'function') generateCaptcha();

    localStorage.setItem('nexlify_logged_in', 'false');
    localStorage.removeItem('nexlify_user');
    localStorage.removeItem('nexlify_token');

    const remembered = localStorage.getItem('nexlify_remember');
    if (remembered) {
        const emailInput = form.querySelector('input[type="email"]');
        if (emailInput) emailInput.value = remembered;
        const checkbox = document.getElementById('rememberMe');
        if (checkbox) checkbox.checked = true;
    }

    let lockTimer = null;

    function showLockout(seconds, origText) {
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        form.querySelectorAll('input').forEach(i => i.disabled = true);

        function tick() {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            btn.innerHTML = `<i class="fas fa-lock"></i> Locked – ${m}:${String(s).padStart(2,'0')} remaining`;
            btn.style.width = btn.style.width || getComputedStyle(btn).width;
            if (seconds <= 0) {
                clearInterval(lockTimer);
                btn.disabled = false;
                btn.style.width = '';
                btn.innerHTML = origText;
                form.querySelectorAll('input').forEach(i => i.disabled = false);
                showToast('✅ Account unlocked. You can login now.');
                return;
            }
            seconds--;
        }
        tick();
        lockTimer = setInterval(tick, 1000);
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let valid = true;
        form.querySelectorAll('input[required]').forEach(input => { if (!validateField(input)) valid = false; });
        if (!valid) return;

        const email       = form.querySelector('input[type="email"]').value.trim();
        const password    = document.getElementById('loginPassword').value;
        const captchaValue = document.getElementById('captchaInput')?.value.trim() || '';
        const remember    = document.getElementById('rememberMe');
        // CAPTCHA text is defined in login.html inline script as `captchaText`
        // but depending on load order it may not be in this scope. Use window.captchaText.
        const liveCaptchaText = (typeof window.captchaText === 'string') ? window.captchaText : (typeof captchaText === 'string' ? captchaText : '');

        const btn      = form.querySelector('button[type="submit"]');
        const origText = btn.innerHTML;
        btn.disabled   = true;
        btn.innerHTML  = '<i class="fas fa-spinner fa-spin"></i> Logging in...';

        if (!captchaValue || !liveCaptchaText || captchaValue !== liveCaptchaText) {
            showToast('❌ CAPTCHA incorrect. Try again!', 'error');
            if (typeof generateCaptcha === 'function') generateCaptcha();
            document.getElementById('captchaInput').value = '';
            btn.disabled  = false;
            btn.innerHTML = origText;
            return;
        }

        showToast('⏳ Logging in...');
        const result = await apiCall('/login', { email, password });

        if (result.locked) {
            showToast('🔒 ' + result.message, 'error');
            showLockout(result.remaining, origText);
            return;
        }

        btn.disabled  = false;
        btn.innerHTML = origText;

        if (result.success) {
            localStorage.setItem('nexlify_user', JSON.stringify(result.user));
            localStorage.setItem('nexlify_logged_in', 'true');
            localStorage.setItem('nexlify_token', result.token);
            if (remember?.checked) localStorage.setItem('nexlify_remember', email);
            else localStorage.removeItem('nexlify_remember');

            // Store session for admin dashboard guard
            sessionStorage.setItem('token', result.token);
            sessionStorage.setItem('userRole', result.user.role);
            sessionStorage.setItem('userName', result.user.name);
            sessionStorage.setItem('userEmail', result.user.email);

            showToast('✅ ' + result.message);
            const role = result.user?.role || 'student';
            setTimeout(() => {
                if (role === 'admin')    window.location.href = 'admin-dashboard.html';
                else if (role === 'hr') window.location.href = 'hr-dashboard.html';
                else                    window.location.href = 'dashboard.html';
            }, 2000);
        } else {
            showToast('❌ ' + result.message, 'error');
        }
    });
}

function initForgotPasswordForm() {
    const form = document.getElementById('forgotPasswordForm');
    if (!form) return;

    const emailInput    = document.getElementById('forgotEmail');
    const otpSection    = document.getElementById('otp-section');
    const resetSection  = document.getElementById('reset-section');
    const sendBtn       = document.getElementById('sendOtpBtn');
    const verifyBtn     = document.getElementById('verifyOtpBtn');
    const resetBtn      = document.getElementById('resetPasswordBtn');
    const otpInput      = document.getElementById('forgotOtp');
    const newPassword   = document.getElementById('newPassword');
    const confirmPassword = document.getElementById('confirmNewPassword');

    let currentEmail = '';

    function resetFormState() {
        otpSection.style.display = 'none';
        resetSection.style.display = 'none';
        verifyBtn.style.display = 'none';
        resetBtn.style.display = 'none';
        sendBtn.style.display = 'block';
        emailInput.disabled = false;
        sendBtn.disabled = false;
        otpInput.value = '';
        newPassword.value = '';
        confirmPassword.value = '';
        emailInput.focus();
    }

    sendBtn.addEventListener('click', async () => {
        const email = emailInput.value.trim();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            showToast('⚠️ Enter a valid email address.', 'warning');
            return;
        }

        sendBtn.disabled = true;
        sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
        const result = await apiCall('/send-password-otp', { email });
        sendBtn.disabled = false;
        sendBtn.innerHTML = 'Send OTP';

        if (result.success) {
            currentEmail = email;
            otpSection.style.display = 'block';
            verifyBtn.style.display = 'block';
            sendBtn.style.display = 'none';
            emailInput.disabled = true;
            showToast('📧 OTP sent! Check your email.');
        } else {
            showToast('❌ ' + result.message, 'error');
        }
    });

    verifyBtn.addEventListener('click', async () => {
        const otp = otpInput.value.trim();
        if (otp.length !== 6) {
            showToast('⚠️ Enter the 6-digit OTP.', 'warning');
            return;
        }
        if (!currentEmail) {
            showToast('⚠️ Email is required first.', 'warning');
            return;
        }

        verifyBtn.disabled = true;
        verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
        const result = await apiCall('/verify-password-otp', { email: currentEmail, otp });
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = 'Verify OTP';

        if (result.success) {
            otpSection.style.display = 'none';
            verifyBtn.style.display = 'none';
            resetSection.style.display = 'block';
            resetBtn.style.display = 'block';
            showToast('✅ OTP verified. Set your new password below.');
        } else {
            showToast('❌ ' + result.message, 'error');
        }
    });

    resetBtn.addEventListener('click', async () => {
        const password = newPassword.value.trim();
        const confirm  = confirmPassword.value.trim();

        if (!password || password.length < 6) {
            showToast('⚠️ Password must have at least 6 characters.', 'warning');
            return;
        }
        if (password !== confirm) {
            showToast('⚠️ Passwords do not match.', 'warning');
            return;
        }
        if (!currentEmail) {
            showToast('⚠️ No verified email found. Request OTP again.', 'warning');
            resetFormState();
            return;
        }

        resetBtn.disabled = true;
        resetBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
        const result = await apiCall('/reset-password', { email: currentEmail, password });
        resetBtn.disabled = false;
        resetBtn.innerHTML = 'Update Password';

        if (result.success) {
            showToast('✅ ' + result.message);
            setTimeout(() => { window.location.href = 'login.html'; }, 1800);
        } else {
            showToast('❌ ' + result.message, 'error');
        }
    });

    resetFormState();
}

function initContactForm() {
    const form = document.getElementById('contactForm');
    if (!form) return;
    // Contact form submission is handled inline in contact.html
    // This function intentionally left as no-op to avoid duplicate listeners
}

function openEnroll(course) {
    const loggedIn = localStorage.getItem('nexlify_logged_in') === 'true';
    const user     = JSON.parse(localStorage.getItem('nexlify_user') || '{}');

    if (!loggedIn || !user.email) {
        showToast('⚠️ Please login or signup first to enroll.', 'warning');
        setTimeout(() => { window.location.href = 'login.html'; }, 2000);
        return;
    }

    const modal = document.getElementById('enroll-modal');
    if (modal) {
        modal.classList.add('active');
        if (course) { const sel = document.getElementById('enroll-course'); if (sel) sel.value = course; }
        const inputs = modal.querySelectorAll('.enroll-input');
        if (inputs[0]) inputs[0].value = user.name  || '';
        if (inputs[1]) inputs[1].value = user.email || '';
        if (inputs[2]) inputs[2].value = user.phone || '';
    }
}

function closeEnroll() {
    document.getElementById('enroll-modal')?.classList.remove('active');
}

async function getCsrfToken(email) {
    try {
        const res  = await fetch(`${API}/csrf-token?email=${encodeURIComponent(email)}`);
        const data = await res.json();
        return data.csrfToken || null;
    } catch {
        return null;
    }
}

async function submitEnroll() {
    const user   = JSON.parse(localStorage.getItem('nexlify_user') || '{}');
    const course = document.getElementById('enroll-course')?.value;
    if (!course) { showToast('⚠️ Please select a course!', 'warning'); return; }

    let valid = true;
    document.querySelectorAll('.enroll-input').forEach(input => {
        if (!input.value.trim()) { input.style.borderColor = '#ef4444'; valid = false; }
        else input.style.borderColor = 'rgba(250,204,21,0.3)';
    });
    if (!valid) { showToast('⚠️ Please fill all fields.', 'warning'); return; }

    const csrfToken = await getCsrfToken(user.email);
    if (!csrfToken) { showToast('❌ Security token error. Please refresh and try again.', 'error'); return; }

    try {
        const res = await fetch(`${API}/enroll`, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
            body    : JSON.stringify({ email: user.email, course })
        });
        const result = await res.json();
        if (result.success) { closeEnroll(); showToast('🎉 ' + result.message); }
        else showToast('❌ ' + result.message, 'error');
    } catch {
        showToast('❌ Cannot connect to server!', 'error');
    }
}

function initScrollIndicator() {
    const el = document.querySelector('.scroll-indicator');
    if (el) el.addEventListener('click', () => {
        (document.querySelector('#about') || document.querySelector('.features'))?.scrollIntoView({ behavior: 'smooth' });
    });

    const backToTop = document.createElement('button');
    backToTop.id = 'back-to-top';
    backToTop.innerHTML = '<i class="fas fa-arrow-up"></i>';
    backToTop.style.cssText = `
        position:fixed;bottom:30px;right:30px;z-index:9998;
        width:50px;height:50px;border-radius:50%;
        background:linear-gradient(135deg,#facc15,#eab308);
        color:#1e293b;border:none;cursor:pointer;
        box-shadow:0 4px 16px rgba(250,204,21,0.4);
        display:none;align-items:center;justify-content:center;
        font-size:1.2rem;transition:all 0.3s;
    `;
    document.body.appendChild(backToTop);

    window.addEventListener('scroll', () => {
        backToTop.style.display = window.scrollY > 500 ? 'flex' : 'none';
    });

    backToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    backToTop.addEventListener('mouseenter', () => {
        backToTop.style.transform  = 'translateY(-4px)';
        backToTop.style.boxShadow  = '0 8px 24px rgba(250,204,21,0.5)';
    });
    backToTop.addEventListener('mouseleave', () => {
        backToTop.style.transform  = 'translateY(0)';
        backToTop.style.boxShadow  = '0 4px 16px rgba(250,204,21,0.4)';
    });
}
