require('dotenv').config();
const express    = require('express');
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const GitHubStrategy = require("passport-github2").Strategy;
const session = require("express-session");
const mysql      = require('mysql2');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const nodemailer = require('nodemailer');
const http       = require('http');
const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const { exec }   = require('child_process');
const { generateCertificateSVG } = require('./certificateGenerator');
const axios      = require('axios');

const app    = express();

const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-session-secret',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// In-memory stores
const adminSockets = new Set();
const chatRooms    = new Map();
const otpStore            = new Map(); // email -> { otp, expires, data }
const passwordResetOtpStore = new Map(); // email -> { otp, expires }
const passwordResetStore    = new Map(); // email -> { expires }
const loginAttempts        = new Map(); // email -> { count, lockedUntil }
const resetStore           = new Map(); // token -> { email, expires }

// Cleanup expired in-memory stores every 5 minutes
setInterval(() => {
    const now = Date.now();
    let cleanedOtp = 0, cleanedPassword = 0, cleanedReset = 0, cleanedLogin = 0;
    
    for (const [email, record] of otpStore) {
        if (record.expires < now) { otpStore.delete(email); cleanedOtp++; }
    }
    for (const [email, record] of passwordResetOtpStore) {
        if (record.expires < now) { passwordResetOtpStore.delete(email); cleanedPassword++; }
    }
    for (const [token, record] of resetStore) {
        if (record.expires < now) { resetStore.delete(token); cleanedReset++; }
    }
    for (const [email, record] of loginAttempts) {
        if (record.lockedUntil < now) { loginAttempts.delete(email); cleanedLogin++; }
    }
    
    if (cleanedOtp + cleanedPassword + cleanedReset + cleanedLogin > 0) {
        console.log(`♻️  Cleaned expired entries: OTP(${cleanedOtp}), Password(${cleanedPassword}), Reset(${cleanedReset}), Login(${cleanedLogin})`);
    }
}, 5 * 60 * 1000);

// Input Validation Functions
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email) && email.length <= 255;
}

function isValidPassword(password) {
    return password && password.length >= 6;
}

function isValidPhone(phone) {
    return phone && phone.length >= 10 && phone.length <= 20;
}

function isValidName(name) {
    return name && name.trim().length >= 2 && name.length <= 255;
}

/** Normalizes course names for consistent database lookups */
function normalizeCourseName(name) {
    return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : name;
}

function validateSignupData(data) {
    const { name, email, phone, password, role } = data;
    if (!isValidName(name)) return { valid: false, error: 'Invalid name' };
    if (!isValidEmail(email)) return { valid: false, error: 'Invalid email' };
    if (!isValidPhone(phone)) return { valid: false, error: 'Invalid phone number' };
    if (!isValidPassword(password)) return { valid: false, error: 'Password must be at least 6 characters' };
    if (!['student', 'admin', 'user', 'hr'].includes(role)) return { valid: false, error: 'Invalid role' };
    return { valid: true };
}

function validateLoginData(data) {
    const { email, password } = data;
    if (!isValidEmail(email)) return { valid: false, error: 'Invalid email' };
    if (!password) return { valid: false, error: 'Password required' };
    return { valid: true };
}

// Rate Limiting Middleware
const rateLimitStore = new Map(); // ip -> { count, resetTime }
function rateLimit(maxRequests = 10, windowMs = 60000) {
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        const record = rateLimitStore.get(ip);
        
        if (!record || now > record.resetTime) {
            rateLimitStore.set(ip, { count: 1, resetTime: now + windowMs });
            next();
        } else if (record.count < maxRequests) {
            record.count++;
            next();
        } else {
            res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
        }
    };
}

// Middleware
const allowedOrigins = new Set([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
]);
if (process.env.BASE_URL) allowedOrigins.add(process.env.BASE_URL);
if (process.env.BASE_URL) {
    allowedOrigins.add(process.env.BASE_URL.replace(/\/$/, ""));
}

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || origin === 'null' || allowedOrigins.has(origin)) return callback(null, true);
        if (!origin || origin === 'null' || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
        callback(new Error('CORS origin denied'));
    },
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

let googleEnabled = false;
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:8080/auth/google/callback"
      },
      async function(accessToken, refreshToken, profile, done) {
        try {
          const email = profile.emails[0].value;
          const user = await findExistingUserByEmail(email);
          if (!user) {
            return done(null, false, { message: 'Account not found. Please sign up first.' });
          }
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    ));
    googleEnabled = true;
} else {
    console.warn('⚠️ Google OAuth credentials missing. Google Login will be disabled.');
}

let githubEnabled = false;
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy({
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: process.env.GITHUB_CALLBACK_URL || "http://localhost:8080/auth/github/callback"
      },
      async function(accessToken, refreshToken, profile, done) {
        try {
          const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
          if (!email) return done(null, false, { message: 'GitHub account must have a public email.' });
          const user = await findExistingUserByEmail(email);
          if (!user) {
            return done(null, false, { message: 'Account not found. Please sign up first.' });
          }
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    ));
    githubEnabled = true;
} else {
    console.warn('⚠️ GitHub OAuth credentials missing. GitHub Login will be disabled.');
}




// Database — single pool
const db = mysql.createPool({
    host             : process.env.DB_HOST || 'zephyr.proxy.rlwy.net',
    port              : process.env.DB_PORT || 3306,
    user             : process.env.DB_USER || 'root',
    password         : process.env.DB_PASSWORD || '',
    database         : process.env.DB_NAME || 'railway',
    waitForConnections: true,
    connectionLimit  : 10,
    multipleStatements: true,
    ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: true
    } : false
});

db.query('SELECT 1', (err) => {
    if (err) console.log('Database connection failed:', err.message);
    else     console.log('MySQL Connected Successfully!');
});

function dbQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.query(sql, params, (err, results) => {
            if (err) return reject(err);
            resolve(results);
        });
    });
}

// ══════════════════════════════════════════════════════════════
// AI MOCK INTERVIEW SYSTEM - ENHANCED SCHEMA
// ══════════════════════════════════════════════════════════════

// Core Tables (Users, Enrollments, etc.)
const coreTablesSql = `
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20),
    password VARCHAR(255) NOT NULL,
    role ENUM('student', 'admin', 'user', 'hr') DEFAULT 'student',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS enrollments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    course VARCHAR(255) NOT NULL,
    status ENUM('active', 'completed', 'dropped', 'pending') DEFAULT 'active',
    enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_enrollment (user_id, course)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS progress (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    course VARCHAR(255) NOT NULL,
    week_no INT NOT NULL,
    completed TINYINT(1) DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_progress (user_id, course, week_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contacts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    subject VARCHAR(255),
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS course_applications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    course_name VARCHAR(255) NOT NULL,
    city VARCHAR(100),
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id VARCHAR(100) PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    user_name VARCHAR(255) NOT NULL,
    status ENUM('active', 'closed') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS chat_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(100) NOT NULL,
    sender ENUM('user', 'admin') NOT NULL,
    message TEXT NOT NULL,
    user_name VARCHAR(255),
    admin_name VARCHAR(255),
    is_read TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

db.query(coreTablesSql, (err) => {
    if (err) {
        console.error('Core tables initialization failed:', err.message);
    } else {
        console.log('✅ Core database tables verified/created.');
    }
});

// Create AI Interview Sessions table
const aiInterviewSessionSql = `
CREATE TABLE IF NOT EXISTS ai_interview_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(64) UNIQUE NOT NULL,
    user_id INT NOT NULL,
    role VARCHAR(100) NOT NULL,
    difficulty VARCHAR(50) NOT NULL,
    status ENUM('ongoing','completed','abandoned') DEFAULT 'ongoing',
    total_questions INT DEFAULT 0,
    current_question INT DEFAULT 0,
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP NULL,
    total_score DECIMAL(5,2) DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX(user_id), INDEX(status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const aiInterviewQaSql = `
CREATE TABLE IF NOT EXISTS ai_interview_qa (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    question_number INT NOT NULL,
    question TEXT NOT NULL,
    ai_question_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_answer TEXT,
    answer_time_seconds INT DEFAULT 0,
    question_score DECIMAL(5,2) DEFAULT 0,
    ai_evaluation TEXT,
    confidence_level VARCHAR(50),
    communication_quality VARCHAR(50),
    technical_accuracy VARCHAR(50),
    FOREIGN KEY (session_id) REFERENCES ai_interview_sessions(id) ON DELETE CASCADE,
    INDEX(session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const aiInterviewFeedbackSql = `
CREATE TABLE IF NOT EXISTS ai_interview_feedback (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_id INT NOT NULL,
    overall_score DECIMAL(5,2) NOT NULL,
    summary TEXT NOT NULL,
    strengths TEXT,
    weaknesses TEXT,
    improvement_areas TEXT,
    feedback_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES ai_interview_sessions(id) ON DELETE CASCADE,
    INDEX(session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

db.query(aiInterviewSessionSql, (err) => {
    if (err) console.error('AI Interview sessions table creation failed:', err.message);
});

db.query(aiInterviewQaSql, (err) => {
    if (err) console.error('AI Interview Q&A table creation failed:', err.message);
});

db.query(aiInterviewFeedbackSql, (err) => {
    if (err) console.error('AI Interview feedback table creation failed:', err.message);
});

// Create interview results storage if missing
const interviewTableSql = `
CREATE TABLE IF NOT EXISTS interview_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    interview_id VARCHAR(64) UNIQUE NOT NULL,
    user_id INT NOT NULL,
    course VARCHAR(255) NOT NULL,
    questions TEXT NOT NULL,
    answers TEXT NOT NULL,
    score INT NOT NULL,
    feedback TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

db.query(interviewTableSql, (err) => {
    if (err) console.error('Interview results table creation failed:', err.message);
});

const certificatesTableSql = `
CREATE TABLE IF NOT EXISTS certificates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    course VARCHAR(255) NOT NULL,
    issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    certificate_id VARCHAR(64) UNIQUE NOT NULL,
    UNIQUE KEY unique_cert (user_id, course),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

db.query(certificatesTableSql, (err) => {
    if (err) console.error('Certificates table creation failed:', err.message);

    // Migration: detect and rename old column names from legacy schema
    // Old schema used: course_name, issue_date, certificate_uuid
    // New schema uses: course, issued_at, certificate_id
    db.query('DESCRIBE certificates', (descErr, cols) => {
        if (descErr) { console.error('Migration describe error:', descErr.message); return; }
        const colNames = (cols || []).map(c => c.Field);

        const renames = [];
        if (colNames.includes('course_name') && !colNames.includes('course'))
            renames.push("ALTER TABLE certificates CHANGE COLUMN course_name course VARCHAR(255) NOT NULL");
        if (colNames.includes('issue_date') && !colNames.includes('issued_at'))
            renames.push("ALTER TABLE certificates CHANGE COLUMN issue_date issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
        if (colNames.includes('certificate_uuid') && !colNames.includes('certificate_id'))
            renames.push("ALTER TABLE certificates CHANGE COLUMN certificate_uuid certificate_id VARCHAR(64) NOT NULL");
        if (!colNames.includes('issued_at') && !colNames.includes('issue_date'))
            renames.push("ALTER TABLE certificates ADD COLUMN issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER course");

        if (renames.length === 0) return; // schema is up to date

        let i = 0;
        function next() {
            if (i >= renames.length) { console.log('✅ Certificates table migration complete.'); return; }
            const sql = renames[i++];
            db.query(sql, (e) => {
                if (e) console.error('Migration step failed:', sql, e.message);
                else console.log('✅ Migration applied:', sql.split(' ').slice(0, 6).join(' '));
                next();
            });
        }
        next();
    });
});

const taskTablesSql = `
CREATE TABLE IF NOT EXISTS interview_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    course VARCHAR(255) NOT NULL,
    description TEXT,
    due_date DATE DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS interview_task_submissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    user_id INT NOT NULL,
    answer TEXT NOT NULL,
    status ENUM('submitted','pending','approved','rejected') DEFAULT 'pending',
    score INT DEFAULT 0,
    remarks TEXT,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL,
    FOREIGN KEY (task_id) REFERENCES interview_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

db.query(taskTablesSql, (err) => {
    if (err) console.error('Task tables creation failed:', err.message);
});

// JWT
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ FATAL ERROR: JWT_SECRET is not set in .env file!');
    process.exit(1);
}

function signJwtForUser(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
}

async function findExistingUserByEmail(email) {
    return new Promise((resolve, reject) => {
        db.query('SELECT id, name, email, phone, role, created_at FROM users WHERE email = ?', [email], (err, rows) => {
            if (err) return reject(err);
            resolve(rows && rows[0] ? rows[0] : null);
        });
    });
}


function authenticateToken(req, res, next) {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') return res.sendStatus(403);
    next();
}

// CSRF
const csrfTokens   = new Map(); // CSRF tokens are still needed
function generateCsrfToken(email) {
    const token = crypto.randomBytes(32).toString('hex');
    csrfTokens.set(email, { token, expires: Date.now() + 3600000 }); // 1 hour expiry
    return token;
}

function validateCsrfToken(email, token) {
    const stored = csrfTokens.get(email);
    if (!stored) return false;
    if (Date.now() > stored.expires) { csrfTokens.delete(email); return false; }
    try { return crypto.timingSafeEqual(Buffer.from(stored.token), Buffer.from(token)); }
    catch { return false; }
}

// Cleanup expired CSRF tokens every hour
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [email, record] of csrfTokens) {
        if (record.expires < now) { csrfTokens.delete(email); cleaned++; }
    }
    if (cleaned > 0) console.log(`♻️  Cleaned ${cleaned} expired CSRF tokens`);
}, 3600000);

function requireAuth(req, res, next) {
    const email = req.params.email || req.body?.email;
    if (!email) return res.status(401).json({ success: false, message: 'Unauthorized' });
    next();
}

function requireCsrf(req, res, next) {
    const email = req.body?.email;
    const token = req.headers['x-csrf-token'];
    if (!email || !token || !validateCsrfToken(email, token))
        return res.status(403).json({ success: false, message: 'Invalid or missing CSRF token' });
    next();
}

// Consolidated Admin Notifications
app.get('/api/admin/notifications', authenticateToken, requireAdmin, (req, res) => {
    try {
        // Recent Chat Messages from users
        const q1 = `SELECT 'chat' as type, user_name as title, message as body, created_at 
                    FROM chat_messages WHERE sender = 'user' ORDER BY created_at DESC LIMIT 5`;
        // Recent Course Applications
        const q2 = `SELECT 'enrollment' as type, full_name as title, course_name as body, applied_at as created_at 
                    FROM course_applications ORDER BY applied_at DESC LIMIT 5`;
        // Recent Contact Messages
        const q3 = `SELECT 'message' as type, name as title, message as body, CURRENT_TIMESTAMP as created_at 
                    FROM contacts ORDER BY id DESC LIMIT 5`;

        db.query(q1, (err, chats) => {
            if (err) { console.error('Admin notifications chat query error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            db.query(q2, (err2, enrolls) => {
                if (err2) { console.error('Admin notifications enrollment query error:', err2); return res.status(500).json({ success: false, message: 'Database error' }); }
                db.query(q3, (err3, messages) => {
                    if (err3) { console.error('Admin notifications contact query error:', err3); return res.status(500).json({ success: false, message: 'Database error' }); }

                    const notifications = [...(chats || []), ...(enrolls || []), ...(messages || [])]
                        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                        .slice(0, 10);
                        
                    res.json({ success: true, notifications });
                });
            });
        });
    } catch (err) {
        console.error('Admin notifications error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

// ── MAIL SYSTEM ──
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

function sendMail(options) {
    transporter.sendMail(options, (err) => {
        if (err) console.log('Mail error:', err.message);
    });
}

// ── CHAT SYSTEM ──
const adminSocketsChat = new Set();

// Get chat sessions for admin
app.get('/api/chat/sessions', authenticateToken, requireAdmin, (req, res) => {
    try {
        const query = `
            SELECT 
                cs.session_id,
                cs.user_email,
                cs.user_name,
                cs.status,
                cs.created_at,
                cs.updated_at,
                COUNT(CASE WHEN cm.is_read = 0 AND cm.sender = 'user' THEN 1 END) as unread
            FROM chat_sessions cs
            LEFT JOIN chat_messages cm ON cs.session_id = cm.session_id
            WHERE cs.status = 'active'
            GROUP BY cs.session_id, cs.user_email, cs.user_name, cs.status, cs.created_at, cs.updated_at
            ORDER BY cs.updated_at DESC
        `;
        
        db.query(query, (err, results) => {
            if (err) {
                console.error('Chat sessions error:', err);
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            res.json(results || []);
        });
    } catch (err) {
        console.error('Chat sessions error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

// Get chat history for the logged-in student
app.get('/api/chat/history/user/:email', authenticateToken, (req, res) => {
    try {
        const { email } = req.params;
        if (req.user.email !== email && req.user.role !== 'admin') return res.sendStatus(403);
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });

        const query = `
            SELECT m.* FROM chat_messages m
            JOIN chat_sessions s ON m.session_id = s.session_id
            WHERE s.user_email = ?
            ORDER BY m.created_at ASC
        `;
        db.query(query, [email], (err, results) => {
            if (err) { console.error('Chat history user error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            res.json(results || []);
        });
    } catch (err) {
        console.error('Chat history user error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

// Get chat history for a session
app.get('/api/chat/history/:sessionId', authenticateToken, requireAdmin, (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID required' });
        
        const query = `
            SELECT * FROM chat_messages 
            WHERE session_id = ? 
            ORDER BY created_at ASC
        `;
        
        db.query(query, [sessionId], (err, results) => {
            if (err) {
                console.error('Chat history error:', err);
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            res.json(results || []);
        });
    } catch (err) {
        console.error('Chat history error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

// Mark messages as read
app.post('/api/chat/mark-read/:sessionId', authenticateToken, requireAdmin, (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID required' });
        
        const query = `
            UPDATE chat_messages 
            SET is_read = 1 
            WHERE session_id = ? AND sender = 'user' AND is_read = 0
        `;
        
        db.query(query, [sessionId], (err) => {
            if (err) {
                console.error('Mark read error:', err);
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            res.json({ success: true });
        });
    } catch (err) {
        console.error('Mark read error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/api/chat/session', (req, res) => {
    try {
        const { email, name } = req.body;
        
        if (!email || !name) {
            return res.status(400).json({ success: false, message: 'Email and name required' });
        }
        if (!isValidEmail(email) || !isValidName(name)) {
            return res.status(400).json({ success: false, message: 'Invalid email or name' });
        }
        
        const sessionId = `chat_${email.replace('@', '_').replace('.', '_')}_${Date.now()}`;
        
        // Check if user has active session
        const checkQuery = `
            SELECT session_id FROM chat_sessions 
            WHERE user_email = ? AND status = 'active' 
            ORDER BY created_at DESC LIMIT 1
        `;
        
        db.query(checkQuery, [email], (err, results) => {
            if (err) {
                console.error('Chat session check error:', err);
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            
            if (results && results.length > 0) {
                // Return existing session
                return res.json({ success: true, sessionId: results[0].session_id });
            }
            
            // Create new session
            const insertQuery = `
                INSERT INTO chat_sessions (session_id, user_email, user_name) 
                VALUES (?, ?, ?)
            `;
            
            db.query(insertQuery, [sessionId, email, name], (err) => {
                if (err) {
                    console.error('Chat session create error:', err);
                    return res.status(500).json({ success: false, message: 'Database error' });
                }
                res.json({ success: true, sessionId });
            });
        });
    } catch (err) {
        console.error('Chat session error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

// ── SOCKET.IO REAL-TIME CHAT ──
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('disconnect', () => {
        adminSocketsChat.delete(socket);
    });

    // Admin joins global channel
    socket.on('admin_join', () => {
        try {
            adminSocketsChat.add(socket);
            console.log('Admin joined chat');
        } catch (err) {
            console.error('Admin join error:', err);
        }
    });

    // Admin joins a specific session room for room-targeted events
    socket.on('admin_join_session', (data) => {
        try {
            const sid = (typeof data === 'string' ? data : (data?.sessionId || data?.session_id || '')).toString().trim();
            if (!sid) return;
            socket.join(sid);
            console.log(`Admin joined session room: ${sid}`);
        } catch (err) {
            console.error('Admin join session error:', err);
        }
    });

    // User joins chat
    socket.on('user_join', (data) => {
        try {
            const { sessionId, session_id, email, name } = data;
            const sid = (sessionId || session_id || '').toString().trim(); // Sanitize ID
            
            if (!sid || !email || !name) return;
            socket.join(sid); // Ensure student joins the room
            socket.userEmail = email;
            socket.userName = name;
            console.log(`User ${name} joined session ${sid}`);
        } catch (err) {
            console.error('User join error:', err);
        }
    });

    // User sends message
    socket.on('user_message', (data) => {
        try {
            const { sessionId, session_id, message, email, name } = data;
            const sid = (sessionId || session_id || '').toString().trim();

            if (!sid || !message || !email || !name) return;
            socket.userEmail = email; // Associate email with socket for direct targeting
            socket.userName = name;
            socket.join(sid); // Auto-rejoin if connection fluttered
            
            // Save message to database
            const query = `INSERT INTO chat_messages (session_id, sender, message, user_name) VALUES (?, 'user', ?, ?)`;
            
            socket.join(sid); // Force join to ensure student is in the room for their own echo
            
            db.query(query, [sid, message, name], (err, result) => {
                if (err) {
                    console.error('Save user message error:', err);
                    return;
                }
                
                // Update session timestamp
                db.query('UPDATE chat_sessions SET updated_at = NOW() WHERE session_id = ?', [sid], (err) => {
                    if (err) console.error('Update session error:', err);
                });
                
                // Broadcast to all admins
                const messageData = {
                    id: result.insertId,
                    sessionId: sid,
                    session_id: sid,
                    sender: 'user',
                    message: message,
                    user_name: name,
                    user_email: email,
                    created_at: new Date().toISOString()
                };
                
                // Broadcast to the specific session room (Student and watching Admins)
                io.to(sid).emit('receive_message', messageData); 
                
                adminSocketsChat.forEach(adminSocket => {
                    try {
                        adminSocket.emit('admin_new_message', messageData);
                    } catch (err) {
                        console.error('Emit error:', err);
                    }
                });
            });
        } catch (err) {
            console.error('User message error:', err);
        }
    });

    // Admin sends message to student
    socket.on('admin_message', (data) => {
        try {
            const { sessionId, session_id, message, adminName, admin_name, user_name, userEmail } = data;
            const finalSessionId = (sessionId || session_id || '').toString().trim();
            
            if (!finalSessionId || !message) {
                console.warn('⚠️ Admin message rejected: Missing sessionId or message content.');
                return;
            }

            const finalAdminName = adminName || admin_name || user_name || 'Admin';
            socket.join(finalSessionId); // Admin joins the room to see the message history/echo
            
            // Save message to database - populating both for compatibility
            const query = `INSERT INTO chat_messages (session_id, sender, message, user_name, admin_name) VALUES (?, 'admin', ?, ?, ?)`;
            
            db.query(query, [finalSessionId, message, finalAdminName, finalAdminName], (err, result) => {
                if (err) {
                    console.error('Save admin message error:', err);
                    return;
                }
                
                // Update session timestamp to move to top of admin list
                db.query('UPDATE chat_sessions SET updated_at = NOW() WHERE session_id = ?', [finalSessionId]);
                
                const messageData = {
                    id: result.insertId,
                    sessionId: finalSessionId,
                    session_id: finalSessionId,
                    sender: 'admin',
                    message: message,
                    user_name: finalAdminName,
                    admin_name: finalAdminName,
                    user_email: userEmail || null,
                    created_at: new Date().toISOString()
                };
                
                // BROADCAST TO ROOM: This is what the student listens to
                io.to(finalSessionId).emit('receive_message', messageData);

                // DIRECT TARGETING: If the student hasn't joined the room yet, find them by email
                for (const [id, s] of io.sockets.sockets) {
                    if (s.userEmail === userEmail && !s.rooms.has(finalSessionId)) {
                        s.emit('receive_message', messageData);
                    }
                }
                
                console.log(`Admin message sent to session ${finalSessionId}:`, messageData);
                
                // Notify all admins to update sidebars/unread counts
                adminSocketsChat.forEach(adminSocket => {
                    try {
                        adminSocket.emit('admin_new_message', messageData);
                    } catch (err) {
                        console.error('Emit error:', err);
                    }
                });
            });
        } catch (err) {
            console.error('Admin message error:', err);
        }
    });
});

function sendWelcomeMail(toEmail, name) {
    sendMail({
        from   : `"Nexlify University" <${process.env.MAIL_USER}>`,
        to     : toEmail,
        subject: '🎉 Welcome to Nexlify University!',
        html   : `
            <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f111a;color:#fff;border-radius:16px;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:40px;text-align:center;">
                    <h1 style="color:#facc15;font-size:2rem;margin:0;">🎓 Nexlify University</h1>
                </div>
                <div style="padding:40px;">
                    <h2 style="color:#facc15;">Welcome, ${name}! 🎉</h2>
                    <p style="color:#cbd5e1;line-height:1.8;">Your account has been created successfully. Start exploring our courses today!</p>
                </div>
                <div style="background:#0a0c14;padding:20px;text-align:center;">
                    <p style="color:#64748b;font-size:0.8rem;margin:0;">© 2025 Nexlify University. All Rights Reserved.</p>
                </div>
            </div>`
    });
}

function sendEnrollmentMail(toEmail, name, course) {
    sendMail({
        from   : `"Nexlify University" <${process.env.MAIL_USER}>`,
        to     : toEmail,
        subject: `📚 Enrolled in ${course}`,
        html   : `
            <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f111a;color:#fff;border-radius:16px;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:40px;text-align:center;">
                    <h1 style="color:#facc15;font-size:2rem;margin:0;">🎓 Nexlify University</h1>
                </div>
                <div style="padding:40px;">
                    <h2 style="color:#facc15;">Enrollment Confirmed, ${name}! 📚</h2>
                    <p style="color:#cbd5e1;line-height:1.8;">You have successfully enrolled in <strong style="color:#facc15;">${course}</strong>.</p>
                </div>
                <div style="background:#0a0c14;padding:20px;text-align:center;">
                    <p style="color:#64748b;font-size:0.8rem;margin:0;">© 2025 Nexlify University. All Rights Reserved.</p>
                </div>
            </div>`
    });
}

function sendContactConfirmationMail(toEmail, name, subject, message) {
    sendMail({
        from   : `"Nexlify University" <${process.env.MAIL_USER}>`,
        to     : process.env.MAIL_USER,
        subject: `📩 New Contact Message from ${name}`,
        html   : `
            <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f111a;color:#fff;border-radius:16px;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:30px;text-align:center;">
                    <h1 style="color:#facc15;font-size:1.5rem;margin:0;">📩 New Contact Message</h1>
                </div>
                <div style="padding:30px;">
                    <table style="width:100%;border-collapse:collapse;">
                        <tr><td style="color:#94a3b8;padding:8px 0;width:80px;">Name:</td><td style="color:#fff;">${name}</td></tr>
                        <tr><td style="color:#94a3b8;padding:8px 0;">Email:</td><td style="color:#facc15;">${toEmail}</td></tr>
                        <tr><td style="color:#94a3b8;padding:8px 0;">Subject:</td><td style="color:#fff;">${subject || 'General Inquiry'}</td></tr>
                    </table>
                    <div style="background:#1e293b;padding:16px;border-radius:10px;margin-top:16px;">
                        <p style="color:#94a3b8;margin:0 0 8px 0;font-size:0.85rem;">Message:</p>
                        <p style="color:#cbd5e1;margin:0;line-height:1.6;">${message}</p>
                    </div>
                </div>
            </div>`
    });
    sendMail({
        from   : `"Nexlify University" <${process.env.MAIL_USER}>`,
        to     : toEmail,
        subject: '✉️ We received your message',
        html   : `
            <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f111a;color:#fff;border-radius:16px;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:40px;text-align:center;">
                    <h1 style="color:#facc15;font-size:2rem;margin:0;">🎓 Nexlify University</h1>
                </div>
                <div style="padding:40px;">
                    <h2 style="color:#facc15;">Thank you, ${name}! 💬</h2>
                    <p style="color:#cbd5e1;line-height:1.8;">We've received your message and will get back to you soon.</p>
                    <div style="background:#1e293b;padding:20px;border-radius:12px;margin:20px 0;">
                        <p style="color:#94a3b8;margin:0 0 8px 0;font-size:0.85rem;">Subject:</p>
                        <h3 style="color:#facc15;margin:0 0 16px 0;">${subject || 'General Inquiry'}</h3>
                        <p style="color:#94a3b8;margin:0 0 8px 0;font-size:0.85rem;">Your Message:</p>
                        <p style="color:#cbd5e1;margin:0;line-height:1.6;">${message}</p>
                    </div>
                    <p style="color:#cbd5e1;line-height:1.8;">Our team typically responds within 24-48 hours.</p>
                </div>
                <div style="background:#0a0c14;padding:20px;text-align:center;">
                    <p style="color:#64748b;font-size:0.8rem;margin:0;">© 2025 Nexlify University. All Rights Reserved.</p>
                </div>
            </div>`
    });
}

function sendSecurityAlertMail(toEmail, name) {
    sendMail({
        from   : `"Nexlify University" <${process.env.MAIL_USER}>`,
        to     : toEmail,
        subject: '🔒 Security Alert — Multiple Failed Login Attempts',
        html   : `
            <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f111a;color:#fff;border-radius:16px;overflow:hidden;">
                <div style="background:linear-gradient(135deg,#7f1d1d,#0f172a);padding:40px;text-align:center;">
                    <h1 style="color:#f87171;font-size:2rem;margin:0;">🔒 Security Alert</h1>
                </div>
                <div style="padding:40px;">
                    <h2 style="color:#f87171;">Hi ${name},</h2>
                    <p style="color:#cbd5e1;line-height:1.8;">We detected multiple failed login attempts on your account. It has been locked for 5 minutes.</p>
                    <p style="color:#cbd5e1;line-height:1.8;">If this wasn't you, please reset your password immediately.</p>
                </div>
                <div style="background:#0a0c14;padding:20px;text-align:center;">
                    <p style="color:#64748b;font-size:0.8rem;margin:0;">© 2025 Nexlify University. All Rights Reserved.</p>
                </div>
            </div>`
    });
}

// ── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/send-otp', rateLimit(5, 60000), (req, res) => {
    try {
        const { name, email, phone, password, role } = req.body;
        
        const validation = validateSignupData({ name, email, phone, password, role });
        if (!validation.valid) return res.status(400).json({ success: false, message: validation.error });

        db.query('SELECT id FROM users WHERE email = ?', [email], async (err, results) => {
            if (err) { console.error('DB error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            if (results.length > 0) return res.json({ success: false, message: 'This email is already registered! Please login instead.' });

            const otp            = Math.floor(100000 + Math.random() * 900000).toString();
            const expires        = Date.now() + 5 * 60 * 1000;
            const hashedPassword = await bcrypt.hash(password, 10);
            otpStore.set(email, { otp, expires, data: { name, email, phone, password: hashedPassword, role } });

            sendMail({
                from   : `"Nexlify University" <${process.env.MAIL_USER}>`,
                to     : email,
                subject: '🔐 Your Nexlify Verification Code',
                html   : `
                    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f111a;color:#fff;border-radius:16px;overflow:hidden;">
                        <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:40px;text-align:center;">
                            <h1 style="color:#facc15;font-size:2rem;margin:0;">🎓 Nexlify University</h1>
                        </div>
                        <div style="padding:40px;text-align:center;">
                            <h2 style="color:#facc15;">Email Verification</h2>
                            <p style="color:#cbd5e1;">Use the code below to verify your email. It expires in 5 minutes.</p>
                            <div style="background:#1e293b;padding:24px;border-radius:12px;margin:24px 0;letter-spacing:8px;font-size:2.5rem;font-weight:800;color:#facc15;">${otp}</div>
                            <p style="color:#64748b;font-size:0.85rem;">If you didn't request this, ignore this email.</p>
                        </div>
                        <div style="background:#0a0c14;padding:20px;text-align:center;">
                            <p style="color:#64748b;font-size:0.8rem;margin:0;">© 2025 Nexlify University. All Rights Reserved.</p>
                        </div>
                    </div>`
            });

            res.json({ success: true, message: 'OTP sent to your email!' });
        });
    } catch (err) {
        console.error('Send OTP error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/forgot-password', rateLimit(5, 60000), (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, message: 'Valid email required!' });

        db.query('SELECT name FROM users WHERE email = ?', [email], (err, results) => {
            if (err) { console.error('Password reset lookup error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            if (results.length === 0) return res.json({ success: false, message: 'No account found with this email.' });

            const name = results[0].name;
            const token = crypto.randomBytes(32).toString('hex');
            const expires = Date.now() + 3600000; // 1 hour
            resetStore.set(token, { email, expires });

            const PORT = process.env.PORT || 8080; // Define PORT here for local fallback
            const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
            const resetLink = `${baseUrl}/reset-password.html?token=${token}`;

            sendMail({
                from: `"Nexlify University" <${process.env.MAIL_USER}>`,
                to: email,
                subject: '🔐 Password Reset Request',
                html: `
                    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f111a;color:#fff;border-radius:16px;padding:40px;text-align:center;">
                        <h2 style="color:#facc15;">Reset Your Password</h2>
                        <p style="color:#cbd5e1;">Hi ${name}, we received a request to reset your password. Click the button below to proceed. This link expires in 1 hour.</p>
                        <a href="${resetLink}" style="display:inline-block;padding:14px 28px;background:#facc15;color:#1e293b;text-decoration:none;border-radius:50px;font-weight:700;margin:20px 0;">Reset Password</a>
                        <p style="color:#64748b;font-size:0.8rem;">If you didn't request this, you can safely ignore this email.</p>
                    </div>`
            });

            res.json({ success: true, message: 'Password reset link sent to your email!' });
        });
    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/send-password-otp', rateLimit(5, 60000), (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, message: 'Valid email required!' });

        db.query('SELECT name FROM users WHERE email = ?', [email], (err, results) => {
            if (err) { console.error('Password OTP lookup error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            if (results.length === 0) return res.json({ success: false, message: 'No account found with this email.' });

            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const expires = Date.now() + 5 * 60 * 1000;
            passwordResetOtpStore.set(email, { otp, expires });

            sendMail({
                from: `"Nexlify University" <${process.env.MAIL_USER}>`,
                to: email,
                subject: '🔐 Your Nexlify Password Reset OTP',
                html: `
                    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0f111a;color:#fff;border-radius:16px;overflow:hidden;">
                        <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);padding:40px;text-align:center;">
                            <h1 style="color:#facc15;font-size:2rem;margin:0;">🎓 Nexlify University</h1>
                        </div>
                        <div style="padding:40px;text-align:center;">
                            <h2 style="color:#facc15;">Password Reset Request</h2>
                            <p style="color:#cbd5e1;">Use the code below to verify your email and reset your password. It expires in 5 minutes.</p>
                            <div style="background:#1e293b;padding:24px;border-radius:12px;margin:24px 0;letter-spacing:8px;font-size:2.5rem;font-weight:800;color:#facc15;">${otp}</div>
                            <p style="color:#64748b;font-size:0.85rem;">If you didn't request this, ignore this email.</p>
                        </div>
                        <div style="background:#0a0c14;padding:20px;text-align:center;">
                            <p style="color:#64748b;font-size:0.8rem;margin:0;">© 2025 Nexlify University. All Rights Reserved.</p>
                        </div>
                    </div>`
            });

            res.json({ success: true, message: 'OTP sent to your email! Check your inbox.' });
        });
    } catch (err) {
        console.error('Send password OTP error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/verify-password-otp', rateLimit(5, 60000), (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP required' });
        
        const record = passwordResetOtpStore.get(email);
        if (!record) return res.json({ success: false, message: 'OTP expired or not found. Please request a new code.' });
        if (Date.now() > record.expires) { passwordResetOtpStore.delete(email); return res.json({ success: false, message: 'OTP expired. Please request a new code.' }); }
        if (record.otp !== otp) return res.json({ success: false, message: 'Invalid OTP. Please check your email.' });

        passwordResetOtpStore.delete(email);
        passwordResetStore.set(email, { expires: Date.now() + 15 * 60 * 1000 });
        res.json({ success: true, message: 'OTP verified. You can now choose a new password.' });
    } catch (err) {
        console.error('Verify password OTP error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/reset-password', rateLimit(5, 60000), async (req, res) => {
    try {
        const { token, email, password } = req.body;

        if (token) {
            const record = resetStore.get(token);
            if (!record) return res.json({ success: false, message: 'Invalid or expired token. Please request a new link.' });
            if (Date.now() > record.expires) { resetStore.delete(token); return res.json({ success: false, message: 'Reset link has expired.' }); }

            if (!isValidPassword(password)) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

            const hashedPassword = await bcrypt.hash(password, 10);
            db.query('UPDATE users SET password = ? WHERE email = ?', [hashedPassword, record.email], (err) => {
                if (err) { console.error('Password reset update error:', err); return res.status(500).json({ success: false, message: 'Failed to update password' }); }
                resetStore.delete(token);
                res.json({ success: true, message: 'Password updated successfully! You can now login.' });
            });
            return;
        }

        if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
        if (!isValidPassword(password)) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        
        const resetRecord = passwordResetStore.get(email);
        if (!resetRecord) return res.json({ success: false, message: 'No verified password reset request found. Please request a new OTP.' });
        if (Date.now() > resetRecord.expires) { passwordResetStore.delete(email); return res.json({ success: false, message: 'Password reset session expired. Please request a new OTP.' }); }

        const hashedPassword = await bcrypt.hash(password, 10);
        db.query('UPDATE users SET password = ? WHERE email = ?', [hashedPassword, email], (err) => {
            if (err) { console.error('Password update error:', err); return res.status(500).json({ success: false, message: 'Failed to update password' }); }
            passwordResetStore.delete(email);
            res.json({ success: true, message: 'Password updated successfully! You can now login.' });
        });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/verify-otp', rateLimit(5, 60000), (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP required' });
        
        const record = otpStore.get(email);
        if (!record)                     return res.json({ success: false, message: 'OTP expired or not found. Please try again.' });
        if (Date.now() > record.expires) { otpStore.delete(email); return res.json({ success: false, message: 'OTP expired. Please try again.' }); }
        if (record.otp !== otp)          return res.json({ success: false, message: 'Invalid OTP. Please check your email.' });

        otpStore.delete(email);
        const { name, phone, password, role } = record.data;
        db.query(
            'INSERT INTO users (name, email, phone, password, role) VALUES (?, ?, ?, ?, ?)',
            [name, email, phone, password, role],
            (err) => {
                if (err) { console.error('OTP verification insert error:', err); return res.status(500).json({ success: false, message: 'Signup failed' }); }
                sendWelcomeMail(email, name);
                res.json({ success: true, message: 'Account created successfully!' });
            }
        );
    } catch (err) {
        console.error('Verify OTP error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/signup', rateLimit(5, 60000), (req, res) => {
    try {
        const { name, email, phone, password, role } = req.body;
        
        const validation = validateSignupData({ name, email, phone, password, role });
        if (!validation.valid) return res.status(400).json({ success: false, message: validation.error });

        db.query('SELECT id FROM users WHERE email = ?', [email], async (err, results) => {
            try {
                if (err) { console.error('DB error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                if (results.length > 0) return res.json({ success: false, message: 'Email already exists!' });

                const hashedPassword = await bcrypt.hash(password, 10);
                db.query(
                    'INSERT INTO users (name, email, phone, password, role) VALUES (?, ?, ?, ?, ?)',
                    [name, email, phone, hashedPassword, role],
                    (err) => {
                        if (err) { console.error('Signup insert error:', err); return res.status(500).json({ success: false, message: 'Signup failed' }); }
                        sendWelcomeMail(email, name);
                        res.json({ success: true, message: 'Account created successfully!' });
                    }
                );
            } catch (innerErr) {
                console.error('Signup processing error:', innerErr);
                res.status(500).json({ success: false, message: 'An error occurred' });
            }
        });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/login', rateLimit(5, 60000), (req, res) => {
    try {
        const { email, password } = req.body;
        
        const validation = validateLoginData({ email, password });
        if (!validation.valid) return res.status(400).json({ success: false, message: validation.error });

        const attempt = loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
        if (Date.now() < attempt.lockedUntil) {
            const remaining = Math.ceil((attempt.lockedUntil - Date.now()) / 1000);
            return res.status(429).json({ success: false, locked: true, remaining, message: `Account locked. Try again in ${Math.ceil(remaining / 60)} minute(s).` });
        }

        db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
            try {
                if (err) { console.error('DB error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                if (results.length === 0) return res.json({ success: false, message: 'No account found! Please signup.' });

                const user  = results[0];
                const match = await bcrypt.compare(password, user.password);

                if (!match) {
                    attempt.count = (attempt.count || 0) + 1;
                    if (attempt.count >= 3) {
                        attempt.lockedUntil = Date.now() + 5 * 60 * 1000;
                        attempt.count       = 0;
                        loginAttempts.set(email, attempt);
                        sendSecurityAlertMail(email, user.name);
                        return res.status(429).json({ success: false, locked: true, remaining: 300, message: 'Too many failed attempts. Account locked for 5 minutes. A security alert has been sent to your email.' });
                    }
                    loginAttempts.set(email, attempt);
                    return res.json({ success: false, message: `Invalid password. ${3 - attempt.count} attempt(s) remaining before lockout.` });
                }

                loginAttempts.delete(email);
                const token = jwt.sign(
                    { id: user.id, email: user.email, role: user.role },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );
                res.json({
                    success: true,
                    message: 'Login successful!',
                    token,
                    user   : { name: user.name, email: user.email, phone: user.phone, role: user.role }
                });
            } catch (innerErr) {
                console.error('Login processing error:', innerErr);
                res.status(500).json({ success: false, message: 'An error occurred' });
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.get('/csrf-token', (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });
    res.json({ success: true, csrfToken: generateCsrfToken(email) });
});

// ── User Routes ───────────────────────────────────────────────────────────────
app.post('/enroll', requireAuth, requireCsrf, (req, res) => {
    try {
        const { email, course: rawCourse } = req.body;
        const course = normalizeCourseName(rawCourse);
        if (!email || !course) return res.status(400).json({ success: false, message: 'Email and course required!' });
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
        if (course.length < 2 || course.length > 255) return res.status(400).json({ success: false, message: 'Invalid course' });

        db.query('SELECT id, name FROM users WHERE email = ?', [email], (err, results) => {
            if (err) { console.error('Enroll user lookup error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            if (results.length === 0) return res.json({ success: false, message: 'User not found!' });

            const { id: userId, name: userName } = results[0];
            db.query('SELECT id FROM enrollments WHERE user_id = ? AND course = ?', [userId, course], (err, rows) => {
                if (err) { console.error('Enroll check error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                if (rows.length > 0) return res.json({ success: false, message: 'Already enrolled in this course!' });

                db.query('INSERT INTO enrollments (user_id, course) VALUES (?, ?)', [userId, course], (err) => {
                    if (err) { console.error('Enroll insert error:', err); return res.status(500).json({ success: false, message: 'Enrollment failed' }); }
                    sendEnrollmentMail(email, userName, course);
                    res.json({ success: true, message: 'Enrolled successfully!' });
                });
            });
        });
    } catch (err) {
        console.error('Enroll error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/contact', rateLimit(5, 60000), (req, res) => {
    try {
        const { name, email, subject, message } = req.body;
        if (!name || !email || !message) return res.status(400).json({ success: false, message: 'Name, email and message are required!' });
        if (!isValidName(name)) return res.status(400).json({ success: false, message: 'Invalid name' });
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
        if (message.length < 10 || message.length > 5000) return res.status(400).json({ success: false, message: 'Message must be between 10 and 5000 characters' });

        db.query(
            'INSERT INTO contacts (name, email, subject, message) VALUES (?, ?, ?, ?)',
            [name, email, subject || 'General Inquiry', message],
            (err) => {
                if (err) { console.error('Contact insert error:', err); return res.status(500).json({ success: false, message: 'Failed to send message' }); }
                sendContactConfirmationMail(email, name, subject || 'General Inquiry', message);
                res.json({ success: true, message: 'Message sent successfully!' });
            }
        );
    } catch (err) {
        console.error('Contact error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.get('/dashboard/:email', authenticateToken, (req, res) => {
    try {
        const { email } = req.params;
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
        if (req.user.email !== email && req.user.role !== 'admin') return res.sendStatus(403);
        
        db.query('SELECT id, name, email, phone, role, created_at FROM users WHERE email = ?', [email], (err, users) => {
            if (err) { console.error('Dashboard user lookup error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            if (!users || users.length === 0) return res.json({ success: false, message: 'User not found' });
            
            const user = users[0];
            db.query('SELECT course, status, enrolled_at FROM enrollments WHERE user_id = ? ORDER BY enrolled_at DESC', [user.id], (err, enrollments) => {
                if (err) { console.error('Dashboard enrollments error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                db.query('SELECT course, week_no, completed FROM progress WHERE user_id = ?', [user.id], (err, progress) => {
                    if (err) { console.error('Dashboard progress error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                    res.json({
                        success    : true,
                        user       : { name: user.name, email: user.email, phone: user.phone, role: user.role, created_at: user.created_at },
                        enrollments: enrollments || [],
                        progress   : progress || []
                    });
                });
            });
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/progress/complete', authenticateToken, (req, res) => {
    try {
        const { email, course: rawCourse, week_no } = req.body;
        const course = normalizeCourseName(rawCourse);
        if (!email || !course || !week_no) return res.status(400).json({ success: false, message: 'Missing required fields' });
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
        if (req.user.email !== email && req.user.role !== 'admin') return res.sendStatus(403);

        db.query('SELECT id FROM users WHERE email = ?', [email], (err, users) => {
            if (err) { console.error('Progress complete user lookup error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            if (!users || users.length === 0) return res.json({ success: false, message: 'User not found' });
            
            db.query(
                'INSERT INTO progress (user_id, course, week_no, completed) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE completed=1',
                [users[0].id, course, week_no],
                (err) => {
                    if (err) { console.error('Progress insert error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                    res.json({ success: true, message: `Module ${week_no} marked as completed!` });
                }
            );
        });
    } catch (err) {
        console.error('Progress complete error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.get('/progress/status/:email/:course', authenticateToken, (req, res) => {
    try {
        const { email, course: rawCourse } = req.params;
        const course = normalizeCourseName(rawCourse);
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
        if (req.user.email !== email && req.user.role !== 'admin') return res.sendStatus(403);
        
        db.query('SELECT id FROM users WHERE email = ?', [email], (err, users) => {
            if (err) { console.error('Progress status user lookup error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            if (!users || users.length === 0) return res.json({ success: false, message: 'User not found' });
            
            db.query(
                'SELECT week_no FROM progress WHERE user_id = ? AND course = ? AND completed = 1',
                [users[0].id, course],
                (err, rows) => {
                    if (err) { console.error('Progress status query error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                    const doneSet    = new Set((rows || []).map(r => String(r.week_no)));
                    const lessonDone = [1, 2, 3].map(i => doneSet.has(String(i)));
                    const quizDone   = [4, 5, 6].map(i => doneSet.has(String(i)));
                    res.json({
                        success    : true,
                        lessonDone,
                        quizDone,
                        overallDone: lessonDone.every(Boolean) && quizDone.every(Boolean)
                    });
                }
            );
        });
    } catch (err) {
        console.error('Progress status error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

// Certificates List Route
app.get('/api/certificates/list/:email', authenticateToken, async (req, res) => {
    try {
        const { email } = req.params;
        if (req.user.email !== email && req.user.role !== 'admin') return res.sendStatus(403);

        const users = await dbQuery('SELECT id, name FROM users WHERE email = ?', [email]);
        if (!users.length) return res.status(404).json({ success: false, message: 'User not found' });
        const userId = users[0].id;

        // Get enrollments
        const enrollments = await dbQuery('SELECT course FROM enrollments WHERE user_id = ?', [userId]);
        const completedCourses = [];

        for (const en of enrollments) {
            const course = normalizeCourseName(en.course);
            // Check if all 6 modules (1-3 lessons, 4-6 quizzes) are completed
            const progress = await dbQuery(
                'SELECT COUNT(*) as count FROM progress WHERE user_id = ? AND course = ? AND completed = 1 AND week_no IN (1,2,3,4,5,6)',
                [userId, course]
            );

            if (progress[0].count === 6) {
                completedCourses.push(course);
                // Ensure record in certificates table
                const existing = await dbQuery('SELECT certificate_id FROM certificates WHERE user_id = ? AND course = ?', [userId, course]);
                if (!existing.length) {
                    const certId = `NX-${crypto.randomBytes(4).toString('hex')}-${userId}`.toUpperCase();
                    // Use INSERT IGNORE to prevent 500 errors during race conditions (multi-click)
                    await dbQuery('INSERT IGNORE INTO certificates (user_id, course, certificate_id) VALUES (?, ?, ?)', [userId, course, certId]);
                }
            }
        }

        res.json({ success: true, certificates: completedCourses });
    } catch (err) {
        console.error('Certificates list error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Download Certificate Route
app.get('/api/certificates/download/:email/:course', authenticateToken, async (req, res) => {
    try {
        const { email: emailParam, course: courseParam } = req.params;

        let email = emailParam;
        let course = normalizeCourseName(courseParam);

        if (req.user.email !== email && req.user.role !== 'admin') return res.sendStatus(403);

        const users = await dbQuery('SELECT id, name FROM users WHERE email = ?', [email]);
        if (!users.length) return res.status(404).json({ success: false, message: 'User not found' });
        const user = users[0];

        // Check if certificate exists (implies completion was verified)
        let certs = await dbQuery(
            'SELECT issued_at, certificate_id FROM certificates WHERE user_id = ? AND course = ?',
            [user.id, course]
        );

        // If record missing, verify completion now and auto-issue it
        if (!certs.length) {
            const progress = await dbQuery(
                'SELECT COUNT(*) as count FROM progress WHERE user_id = ? AND course = ? AND completed = 1 AND week_no IN (1,2,3,4,5,6)',
                [user.id, course]
            );

            const progressCount = progress?.[0]?.count ?? 0;

            // Targeted diagnostics (safe, no stack traces)
            console.log('📄 Certificate download attempt:', {
                email,
                normalizedCourse: course,
                userId: user.id,
                progressCount,
                certsCount: certs.length
            });

            if (progressCount === 6) {
                const certId = `NX-${crypto.randomBytes(4).toString('hex')}-${user.id}`.toUpperCase();
                // Use INSERT IGNORE to prevent errors if certificate was created by another process/request
                await dbQuery(
                    'INSERT IGNORE INTO certificates (user_id, course, certificate_id) VALUES (?, ?, ?)',
                    [user.id, course, certId]
                );

                // Re-fetch to get issued_at and ID
                certs = await dbQuery(
                    'SELECT issued_at, certificate_id FROM certificates WHERE user_id = ? AND course = ?',
                    [user.id, course]
                );
            }
        }

        // Defensive: ensure certs exist before accessing certs[0]
        if (!certs || !certs.length || !certs[0]?.issued_at || !certs[0]?.certificate_id) {
            console.warn('⚠️ Certificate missing after auto-issue check:', {
                email,
                normalizedCourse: course,
                userId: user.id
            });
            return res.status(403).json({ success: false, message: 'Certificate not earned yet' });
        }

        // Robust date parsing to prevent RangeError on invalid database timestamps
        const dateObj = new Date(certs[0].issued_at);
        const isValidDate = !isNaN(dateObj.getTime());
        const dateString = isValidDate ? dateObj.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }) : new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

        const svg = generateCertificateSVG(
            user.name || 'Student',
            course,
            'Nexlify University',
            dateString,
            certs[0].certificate_id || 'NX-UNKNOWN'
        );

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="Certificate_${course.replace(/\s+/g, '_')}.svg"`
        );
        res.send(svg);
    } catch (err) {
        console.error('Certificate download error:', err);
        res.status(500).json({ success: false, message: 'Server error during certificate generation', error: err.message });
    }
});

app.get('/enrollments/:email', authenticateToken, (req, res) => {
    try {
        const { email } = req.params;
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
        if (req.user.email !== email && req.user.role !== 'admin') return res.sendStatus(403);
        
        db.query('SELECT id FROM users WHERE email = ?', [email], (err, results) => {
            if (err) { console.error('Enrollments user lookup error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            if (!results || results.length === 0) return res.json({ success: true, enrollments: [] });
            
            db.query(
                'SELECT course, status, enrolled_at FROM enrollments WHERE user_id = ?',
                [results[0].id],
                (err, rows) => {
                    if (err) { console.error('Enrollments query error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                    res.json({ success: true, enrollments: rows || [] });
                }
            );
        });
    } catch (err) {
        console.error('Enrollments error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});
// GOOGLE LOGIN
app.get("/auth/google",
  (req, res, next) => {
    if (!googleEnabled) return res.status(501).json({ success: false, message: 'Google Login not configured.' });
    passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
  }
);

app.get("/auth/google/callback",
  (req, res, next) => {
    if (!googleEnabled) return res.redirect('/login.html?error=config');
    passport.authenticate("google", {
      failureRedirect: "/login.html"
    })(req, res, next);
  },
  (req, res) => {
    const token = signJwtForUser(req.user);
    const user = { name: req.user.name, email: req.user.email, role: req.user.role };
    const userData = encodeURIComponent(JSON.stringify(user));
    // Redirect to login.html with the token so script.js can process the session
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.redirect(`${baseUrl}/login.html?token=${token}&user=${userData}&oauth=success`);
  }
);

// GITHUB LOGIN
app.get("/auth/github",
  (req, res, next) => {
    if (!githubEnabled) return res.status(501).json({ success: false, message: 'GitHub Login not configured.' });
    passport.authenticate("github", { scope: ["user:email"] })(req, res, next);
  }
);

app.get("/auth/github/callback",
  (req, res, next) => {
    if (!githubEnabled) return res.redirect('/login.html?error=config');
    passport.authenticate("github", {
      failureRedirect: "/login.html"
    })(req, res, next);
  },
  (req, res) => {
    const token = signJwtForUser(req.user);
    const user = { name: req.user.name, email: req.user.email, role: req.user.role };
    const userData = encodeURIComponent(JSON.stringify(user));
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.redirect(`${baseUrl}/login.html?token=${token}&user=${userData}&oauth=success`);
  }
);

// Admin API (JWT-protected)
app.get('/api/admin/stats', authenticateToken, requireAdmin, (req, res) => {
    try {
        const q1 = `
            SELECT
                (SELECT COUNT(*) FROM users WHERE role = 'student') AS totalStudents,
                ((SELECT COUNT(*) FROM course_applications) + (SELECT COUNT(*) FROM enrollments)) AS courseApps,
                (SELECT COUNT(*) FROM course_applications WHERE status = 'pending') AS pendingCourseApps,
                ((SELECT COUNT(*) FROM course_applications WHERE status = 'approved') + (SELECT COUNT(*) FROM enrollments WHERE status IN ('active','completed'))) AS approvedCourseApps,
                ((SELECT COUNT(*) FROM course_applications WHERE status = 'rejected') + (SELECT COUNT(*) FROM enrollments WHERE status = 'dropped')) AS rejectedCourseApps,
                (SELECT COUNT(*) FROM contacts) AS messages,
                (SELECT COUNT(*) FROM chat_sessions WHERE status = 'active') AS activeChats,
                (SELECT COUNT(*) FROM enrollments) AS totalEnrollments,
                (SELECT COUNT(*) FROM interview_results) AS interviewCount,
                (SELECT AVG(score) FROM interview_results) AS avgInterviewScore,
                (SELECT COUNT(DISTINCT user_id) FROM interview_results) AS interviewAttendees,
                (SELECT COUNT(*) FROM interview_tasks) AS taskCount,
                (SELECT COUNT(*) FROM interview_task_submissions WHERE status = 'pending') AS pendingTaskReviews
        `;

        const q2 = `
            SELECT course, COUNT(*) as count
            FROM enrollments
            GROUP BY course
        `;

        db.query(q1, (err, statsRows) => {
            if (err) { console.error('Admin stats query 1 error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            db.query(q2, (err2, courseRows) => {
                if (err2) { console.error('Admin stats query 2 error:', err2); return res.status(500).json({ success: false, message: 'Database error' }); }

                const stats = (statsRows && statsRows[0]) ? statsRows[0] : {};
                const courseBreakdown = Array.isArray(courseRows) ? courseRows : [];

                res.json({
                    courseApps         : stats.courseApps         ?? 0,
                    pendingCourseApps  : stats.pendingCourseApps  ?? 0,
                    approvedCourseApps : stats.approvedCourseApps ?? 0,
                    rejectedCourseApps : stats.rejectedCourseApps ?? 0,
                    messages           : stats.messages           ?? 0,
                    activeChats        : stats.activeChats        ?? 0,
                    totalStudents      : stats.totalStudents      ?? 0,
                    totalEnrollments   : stats.totalEnrollments   ?? 0,
                    interviewsConducted: stats.interviewCount    ?? 0,
                    averageInterviewScore: Math.round(stats.avgInterviewScore ?? 0),
                    interviewAttendees: stats.interviewAttendees ?? 0,
                    pendingTaskReviews : stats.pendingTaskReviews ?? 0,
                    courseDistribution : courseBreakdown
                });
            });
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.get('/api/admin/course-applications', authenticateToken, requireAdmin, (req, res) => {
    try {
        // Show both explicit course_applications AND student enrollments so admin sees all
        db.query(
            `SELECT 
                ca.id,
                ca.full_name,
                ca.email,
                ca.phone,
                ca.course_name,
                ca.city,
                ca.status,
                ca.applied_at,
                'application' AS src,
                0 AS completed_count,
                CASE 
                    WHEN ca.course_name = 'Full Stack Development' THEN 8
                    WHEN ca.course_name = 'AI & Machine Learning' THEN 6
                    WHEN ca.course_name = 'Cyber Security' THEN 4
                    WHEN ca.course_name = 'Digital Marketing' THEN 4
                    WHEN ca.course_name = 'Project Management' THEN 4
                    WHEN ca.course_name = 'UI/UX Design' THEN 3
                    ELSE 1
                END AS total_count
            FROM course_applications ca
            UNION ALL
            SELECT 
                (e.id + 100000) AS id,
                u.name AS full_name,
                u.email,
                u.phone,
                e.course AS course_name,
                NULL AS city,
                CASE e.status
                    WHEN 'active'    THEN 'approved'
                    WHEN 'completed' THEN 'approved'
                    WHEN 'dropped'   THEN 'rejected'
                    ELSE 'pending'
                END AS status,
                e.enrolled_at AS applied_at,
                'enrollment' AS src,
                0 AS completed_count,
                1 AS total_count
            FROM enrollments e
            JOIN users u ON e.user_id = u.id
            ORDER BY applied_at DESC`,
            (err, results) => {
                if (err) { console.error('Admin course applications error:', err); return res.status(500).json({ error: 'Database error' }); }
                res.json(Array.isArray(results) ? results : []);
            }
        );
    } catch (err) {
        console.error('Admin course applications error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

app.patch('/api/admin/course-applications/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { status } = req.body;
        if (!status || !['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        if (id > 100000) {
            // Enrollment record — map approve/reject to enrollment status
            const enrollStatus = status === 'rejected' ? 'dropped' : 'active';
            db.query('UPDATE enrollments SET status = ? WHERE id = ?', [enrollStatus, id - 100000], (err) => {
                if (err) { console.error('Admin patch enrollment error:', err); return res.status(500).json({ error: 'Database error' }); }
                res.json({ success: true });
            });
        } else {
            db.query('UPDATE course_applications SET status = ? WHERE id = ?', [status, id], (err) => {
                if (err) { console.error('Admin patch application error:', err); return res.status(500).json({ error: 'Database error' }); }
                res.json({ success: true });
            });
        }
    } catch (err) {
        console.error('Admin patch error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

app.post('/api/course-applications', rateLimit(5, 60000), (req, res) => {
    try {
        const { full_name, email, phone, course_name, city } = req.body;
        if (!full_name || !email || !course_name) return res.status(400).json({ success: false, message: 'Name, email and course are required.' });
        if (!isValidName(full_name)) return res.status(400).json({ success: false, message: 'Invalid name' });
        if (!isValidEmail(email)) return res.status(400).json({ success: false, message: 'Invalid email' });
        if (phone && !isValidPhone(phone)) return res.status(400).json({ success: false, message: 'Invalid phone number' });
        if (course_name.length < 2 || course_name.length > 255) return res.status(400).json({ success: false, message: 'Invalid course name' });
        
        db.query(
            'INSERT INTO course_applications (full_name, email, phone, course_name, city) VALUES (?, ?, ?, ?, ?)',
            [full_name, email, phone || null, course_name, city || null],
            (err, result) => {
                if (err) { console.error('Application insert error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                res.json({ success: true, id: result.insertId, message: 'Application submitted successfully!' });
            }
        );
    } catch (err) {
        console.error('Course application error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

// GET all students with enrollment counts (admin only)
app.get('/api/admin/students', authenticateToken, requireAdmin, (req, res) => {
    try {
        const query = `
            SELECT u.id, u.name, u.email, u.phone, u.created_at,
                   COUNT(e.id) AS enrollment_count,
                   GROUP_CONCAT(e.course ORDER BY e.enrolled_at DESC SEPARATOR ', ') AS courses
            FROM users u
            LEFT JOIN enrollments e ON u.id = e.user_id
            WHERE u.role = 'student'
            GROUP BY u.id, u.name, u.email, u.phone, u.created_at
            ORDER BY u.created_at DESC
        `;
        db.query(query, (err, results) => {
            if (err) { console.error('Admin students error:', err); return res.status(500).json({ error: 'Database error' }); }
            res.json(Array.isArray(results) ? results : []);
        });
    } catch (err) {
        console.error('Admin students error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

app.get('/api/admin/interview-results', authenticateToken, requireAdmin, (req, res) => {
    try {
        const query = `
            SELECT r.id, r.interview_id, u.name AS student_name, u.email, r.course, r.score, r.feedback, r.created_at
            FROM interview_results r
            JOIN users u ON u.id = r.user_id
            ORDER BY r.created_at DESC
            LIMIT 30
        `;
        db.query(query, (err, results) => {
            if (err) { console.error('Admin interview results error:', err); return res.status(500).json({ error: 'Database error' }); }
            res.json(Array.isArray(results) ? results : []);
        });
    } catch (err) {
        console.error('Admin interview results error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

app.get('/api/student/tasks', authenticateToken, (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
        db.query('SELECT DISTINCT course FROM enrollments WHERE user_id = ?', [userId], (err, rows) => {
            if (err) { console.error('Student tasks query error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            const courses = Array.isArray(rows) ? rows.map(r => r.course) : [];
            const sql = `
                SELECT
                    t.id,
                    t.title,
                    t.course,
                    t.description,
                    DATE_FORMAT(t.due_date, '%Y-%m-%d') AS due_date,
                    t.created_at,
                    (SELECT status FROM interview_task_submissions s WHERE s.task_id = t.id AND s.user_id = ? ORDER BY submitted_at DESC LIMIT 1) AS submission_status,
                    (SELECT answer FROM interview_task_submissions s WHERE s.task_id = t.id AND s.user_id = ? ORDER BY submitted_at DESC LIMIT 1) AS answer,
                    (SELECT score FROM interview_task_submissions s WHERE s.task_id = t.id AND s.user_id = ? ORDER BY submitted_at DESC LIMIT 1) AS score,
                    (SELECT remarks FROM interview_task_submissions s WHERE s.task_id = t.id AND s.user_id = ? ORDER BY submitted_at DESC LIMIT 1) AS remarks,
                    (SELECT submitted_at FROM interview_task_submissions s WHERE s.task_id = t.id AND s.user_id = ? ORDER BY submitted_at DESC LIMIT 1) AS submitted_at
                FROM interview_tasks t
                WHERE t.course = 'General'${courses.length ? ' OR t.course IN (?)' : ''}
                ORDER BY t.created_at DESC
            `;
            const params = [userId, userId, userId, userId, userId];
            if (courses.length) params.push(courses);
            db.query(sql, params, (err2, tasks) => {
                if (err2) { console.error('Student tasks load error:', err2); return res.status(500).json({ success: false, message: 'Database error' }); }
                res.json({ success: true, tasks: Array.isArray(tasks) ? tasks : [] });
            });
        });
    } catch (err) {
        console.error('Student tasks error:', err);
        res.status(500).json({ success: false, message: 'An error occurred' });
    }
});

app.post('/api/student/task-submit', authenticateToken, (req, res) => {
    try {
        const userId = req.user?.id;
        const { taskId, answer } = req.body;
        if (!userId || !taskId || typeof answer !== 'string') return res.status(400).json({ success: false, message: 'Task and answer are required.' });
        const cleanAnswer = answer.trim();
        if (!cleanAnswer) return res.status(400).json({ success: false, message: 'Answer cannot be empty.' });

        db.query(
            'SELECT id FROM interview_task_submissions WHERE task_id = ? AND user_id = ? ORDER BY submitted_at DESC LIMIT 1',
            [taskId, userId],
            (err, rows) => {
                if (err) { console.error('Task submission lookup error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
                if (Array.isArray(rows) && rows.length > 0) {
                    db.query(
                        'UPDATE interview_task_submissions SET answer = ?, status = ?, submitted_at = CURRENT_TIMESTAMP, reviewed_at = NULL WHERE id = ?',
                        [cleanAnswer, 'submitted', rows[0].id],
                        (err2) => {
                            if (err2) { console.error('Task submission update error:', err2); return res.status(500).json({ success: false, message: 'Database error' }); }
                            res.json({ success: true, message: 'Task updated and submitted for review.' });
                        }
                    );
                } else {
                    db.query(
                        'INSERT INTO interview_task_submissions (task_id, user_id, answer, status) VALUES (?, ?, ?, ?)',
                        [taskId, userId, cleanAnswer, 'submitted'],
                        (err2) => {
                            if (err2) { console.error('Task submission insert error:', err2); return res.status(500).json({ success: false, message: 'Database error' }); }
                            res.json({ success: true, message: 'Task submitted successfully.' });
                        }
                    );
                }
            }
        );
    } catch (err) {
        console.error('Task submit error:', err);
        res.status(500).json({ success: false, message: 'An error occurred while submitting the task.' });
    }
});

app.get('/api/student/task-results', authenticateToken, (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
        const sql = `
            SELECT s.id, s.task_id, t.title, t.course, s.answer, s.status, s.score, s.remarks,
                   DATE_FORMAT(s.submitted_at, '%Y-%m-%d %H:%i') AS submitted_at,
                   DATE_FORMAT(s.reviewed_at, '%Y-%m-%d %H:%i') AS reviewed_at
            FROM interview_task_submissions s
            JOIN interview_tasks t ON t.id = s.task_id
            WHERE s.user_id = ?
            ORDER BY s.submitted_at DESC
        `;
        db.query(sql, [userId], (err, rows) => {
            if (err) { console.error('Student task results error:', err); return res.status(500).json({ success: false, message: 'Database error' }); }
            res.json({ success: true, submissions: Array.isArray(rows) ? rows : [] });
        });
    } catch (err) {
        console.error('Student task results exception:', err);
        res.status(500).json({ success: false, message: 'An error occurred.' });
    }
});

app.get('/api/admin/tasks', authenticateToken, requireAdmin, (req, res) => {
    try {
        const query = `
            SELECT t.id, t.title, t.course, t.description, DATE_FORMAT(t.due_date, '%Y-%m-%d') AS due_date,
                   t.created_at,
                   COUNT(s.id) AS submissions,
                   SUM(s.status = 'pending') AS pending_reviews
            FROM interview_tasks t
            LEFT JOIN interview_task_submissions s ON s.task_id = t.id
            GROUP BY t.id
            ORDER BY t.created_at DESC
        `;
        db.query(query, (err, tasks) => {
            if (err) { console.error('Admin tasks error:', err); return res.status(500).json({ error: 'Database error' }); }
            res.json(Array.isArray(tasks) ? tasks : []);
        });
    } catch (err) {
        console.error('Admin tasks error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

app.post('/api/admin/tasks', authenticateToken, requireAdmin, (req, res) => {
    try {
        const { title, course, description, due_date } = req.body;
        if (!title || !course) return res.status(400).json({ error: 'Task title and course are required.' });
        db.query(
            'INSERT INTO interview_tasks (title, course, description, due_date) VALUES (?, ?, ?, ?)',
            [title.trim(), course.trim(), description || null, due_date || null],
            (err, result) => {
                if (err) { console.error('Create task error:', err); return res.status(500).json({ error: 'Database error' }); }
                res.json({ success: true, id: result.insertId, message: 'Task created successfully.' });
            }
        );
    } catch (err) {
        console.error('Admin create task exception:', err);
        res.status(500).json({ error: 'An error occurred.' });
    }
});

app.get('/api/admin/task-submissions', authenticateToken, requireAdmin, (req, res) => {
    try {
        const query = `
            SELECT s.id, s.task_id, t.title AS task_title, t.course, u.name AS student_name, u.email, s.answer, s.status, s.score, s.remarks,
                   DATE_FORMAT(s.submitted_at, '%Y-%m-%d %H:%i') AS submitted_at,
                   DATE_FORMAT(s.reviewed_at, '%Y-%m-%d %H:%i') AS reviewed_at
            FROM interview_task_submissions s
            JOIN interview_tasks t ON t.id = s.task_id
            JOIN users u ON u.id = s.user_id
            ORDER BY s.submitted_at DESC
            LIMIT 50
        `;
        db.query(query, (err, rows) => {
            if (err) { console.error('Admin task submissions error:', err); return res.status(500).json({ error: 'Database error' }); }
            res.json(Array.isArray(rows) ? rows : []);
        });
    } catch (err) {
        console.error('Admin task submissions exception:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

app.patch('/api/admin/task-submissions/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { status, score, remarks } = req.body;
        if (!id || !['approved','rejected','pending'].includes(status)) return res.status(400).json({ error: 'Invalid review status.' });
        const numericScore = Math.min(100, Math.max(0, parseInt(score, 10) || 0));
        db.query(
            'UPDATE interview_task_submissions SET status = ?, score = ?, remarks = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',
            [status, numericScore, remarks || null, id],
            (err) => {
                if (err) { console.error('Admin task review update error:', err); return res.status(500).json({ error: 'Database error' }); }
                res.json({ success: true, message: 'Submission reviewed successfully.' });
            }
        );
    } catch (err) {
        console.error('Admin task review exception:', err);
        res.status(500).json({ error: 'An error occurred.' });
    }
});

app.get('/api/admin/leaderboard', authenticateToken, requireAdmin, (req, res) => {
    try {
        const query = `
            SELECT u.name AS student_name, u.email,
                   ROUND(COALESCE(AVG(r.score), 0), 1) AS avg_interview_score,
                   COUNT(DISTINCT s.id) AS reviews_completed,
                   ROUND((COALESCE(AVG(r.score), 0) + COALESCE(AVG(s.score), 0)) / 2, 1) AS ranking_score
            FROM users u
            LEFT JOIN interview_results r ON u.id = r.user_id
            LEFT JOIN interview_task_submissions s ON u.id = s.user_id AND s.status = 'approved'
            WHERE u.role = 'student'
            GROUP BY u.id
            ORDER BY ranking_score DESC, avg_interview_score DESC
            LIMIT 10
        `;
        db.query(query, (err, rows) => {
            if (err) { console.error('Admin leaderboard error:', err); return res.status(500).json({ error: 'Database error' }); }
            res.json(Array.isArray(rows) ? rows : []);
        });
    } catch (err) {
        console.error('Admin leaderboard exception:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

app.get('/api/admin/messages', authenticateToken, requireAdmin, (req, res) => {
    try {
        const query = 'SELECT id, name, email, subject, message, id as created_at FROM contacts ORDER BY id DESC';
        db.query(query, (err, results) => {
            if (err) {
                console.error('Database Error in /api/admin/messages:', err);
                return res.status(500).json({ error: 'Database error', message: err.message });
            }
            const messages = (Array.isArray(results) ? results : []).map(m => ({
                id: m.id,
                full_name: m.name || m.full_name || 'N/A',
                email: m.email,
                subject: m.subject,
                message: m.message,
                received_at: m.created_at || m.received_at
            }));
            res.json({ success: true, messages });
        });
    } catch (err) {
        console.error('Admin messages route exception:', err);
        res.status(500).json({ success: false, error: 'An error occurred' });
    }
});

// ══════════════════════════════════════════════════════════════
// AI MOCK INTERVIEW SYSTEM - COMPREHENSIVE API
// ══════════════════════════════════════════════════════════════

// Gemini Integration Helper
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const CURATED_QUESTION_BANK = {
    "Digital Marketing": {
        "Beginner": [
            "How would you improve a brand’s Instagram engagement?", "Which social media platform works best for product marketing and why?", "How do hashtags help in marketing?", "How would you attract more visitors to a website?", "Why are keywords important in SEO?", "How do you create engaging content for users?", "Which metrics would you track for a marketing campaign?", "How can email marketing increase sales?", "How would you handle a poorly performing ad campaign?", "Why is branding important for a business?", "How do online ads target the right audience?", "What steps would you take before launching a campaign?", "How can businesses gain organic traffic?", "How do influencers help brands grow?", "Describe a successful digital campaign you know."
        ],
        "Intermediate": [
            "How would you improve the conversion rate of a website?", "Why do some ad campaigns fail even with high traffic?", "How would you compare SEO and paid advertising?", "Which factors affect Google search rankings?", "How would you reduce bounce rate on a website?", "How do businesses use analytics to improve marketing?", "Describe the process of planning a social media campaign?", "How would you identify the target audience for a product?", "Why is content strategy important for SEO?", "How do businesses generate leads online?", "How would you optimize a low-performing email campaign?", "Why is A/B testing useful in marketing?", "How do marketers measure campaign success?", "How would you market a newly launched product online?", "Explain how retargeting ads work."
        ],
        "Advanced": [
            "How would you scale a global digital marketing campaign?", "Explain how attribution models affect marketing decisions.", "How would you optimize customer acquisition cost?", "How do AI tools improve digital marketing strategies?", "How would you handle a sudden drop in organic traffic?", "Explain the role of automation in modern marketing.", "How would you create a multi-channel marketing strategy?", "Why is audience segmentation important in large campaigns?", "How do businesses predict customer behavior using analytics?", "How would you improve ROI for paid advertising?", "Explain the importance of CRM integration in marketing.", "How do brands maintain consistency across platforms?", "How would you analyze competitor marketing strategies?", "Explain performance marketing with a real-world example.", "How would you manage marketing during a brand crisis?"
        ]
    },
    "Project Management": {
        "Beginner": [
            "How do you organize tasks in a project?", "How would you handle missed deadlines?", "Describe a situation where teamwork was important.", "How do you prioritize multiple tasks?", "Why is communication important in projects?", "How would you manage a small team?", "What steps do you take before starting a project?", "How do meetings help project success?", "How do you deal with team conflicts?", "Why is planning important in project management?", "How do you track project progress?", "How would you manage limited resources?", "Describe the role of a project manager.", "How do you keep a project within budget?", "How would you motivate your team?"
        ],
        "Intermediate": [
            "How would you manage scope changes during a project?", "Why do projects fail despite proper planning?", "How would you handle communication gaps in a team?", "Explain the difference between Agile and Waterfall approaches.", "How would you manage project risks effectively?", "How do project managers balance quality and deadlines?", "Describe the importance of sprint planning.", "How would you resolve conflicts between team members?", "Why is stakeholder management critical in projects?", "How would you allocate resources across multiple tasks?", "Explain how project progress can be monitored.", "How would you manage a delayed project delivery?", "Why is documentation important in project management?", "How do KPIs help measure project performance?", "Describe a strategy to improve team productivity."
        ],
        "Advanced": [
            "How would you manage a large-scale international project?", "Explain the role of governance in project management.", "How would you identify the critical path in a project?", "Why is risk mitigation important in enterprise projects?", "How would you manage dependencies across multiple teams?", "Explain earned value management with an example.", "How would you recover a failing project?", "Why is change control necessary in complex projects?", "How would you handle stakeholder resistance?", "Explain portfolio management in organizations.", "How would you estimate project timelines accurately?", "Why is strategic alignment important in project execution?", "How would you manage resource shortages in critical phases?", "Explain how Agile scaling frameworks support large projects.", "How would you measure long-term project success?"
        ]
    },
    "Cyber Security": {
        "Beginner": [
            "How would you identify a phishing email?", "Why should users avoid weak passwords?", "How can companies protect sensitive data?", "What would you do if a system gets hacked?", "Why is encryption important in communication?", "How do hackers exploit unsecured websites?", "How can two-factor authentication improve security?", "What steps can prevent malware attacks?", "Why should software be updated regularly?", "How does a firewall protect a network?", "How would you secure a public Wi-Fi connection?", "What risks come from downloading unknown files?", "How can social engineering attacks be prevented?", "Why is cyber security important for businesses?", "Describe a common cyber attack you know."
        ],
        "Intermediate": [
            "How would you protect a website from SQL injection attacks?", "Why are phishing attacks successful even today?", "How would you perform a vulnerability assessment?", "Explain the difference between authentication and authorization.", "How would you secure cloud-based applications?", "Why is penetration testing important?", "How would you respond to a ransomware attack?", "Explain how public key encryption works.", "How would you identify suspicious network activity?", "Why is secure coding important in software development?", "How would you prevent session hijacking?", "Explain the risks of social engineering attacks.", "How would you secure APIs from unauthorized access?", "Why are firewalls and IDS systems both necessary?", "How would you educate employees about cyber security threats?"
        ],
        "Advanced": [
            "How would you implement a Zero Trust security model?", "Explain how SIEM systems help organizations detect threats.", "How would you handle a large-scale DDoS attack?", "Why is threat intelligence important in cyber defense?", "How would you investigate a data breach incident?", "Explain privilege escalation attacks with examples.", "How would you secure enterprise cloud infrastructure?", "Why is endpoint security critical in remote work environments?", "How would you design a secure authentication system?", "Explain the lifecycle of penetration testing.", "How would you manage security compliance in organizations?", "Why is digital forensics important after cyber attacks?", "How would you detect insider threats in a company?", "Explain advanced persistent threats (APT).", "How would you create an incident response strategy?"
        ]
    },
    "UI/UX Design": {
        "Beginner": [
            "How would you improve the design of a confusing website?", "Why is user experience important in apps?", "How do colors affect user behavior?", "Why should designs be responsive?", "How would you make an app easy to use?", "What makes a good user interface?", "How do designers collect user feedback?", "Why is typography important in design?", "How would you redesign a slow mobile app?", "What steps do you follow before creating a design?", "How does whitespace improve UI design?", "How would you design for visually impaired users?", "Why are wireframes useful in projects?", "How do animations improve user experience?", "Describe a well-designed app and why you like it."
        ],
        "Intermediate": [
            "How would you improve navigation in a complex application?", "Why is user research important before designing?", "How would you create a mobile-first design?", "Explain the importance of consistency in UI design.", "How would you improve accessibility in a website?", "Why are user personas useful in UX design?", "How would you conduct usability testing?", "Explain how visual hierarchy guides users.", "How would you redesign an outdated application?", "Why are microinteractions important in UX?", "How would you balance aesthetics and usability?", "Explain the role of information architecture in UX.", "How would you reduce cognitive load in an interface?", "Why is responsive design important for user retention?", "How would you evaluate whether a design is successful?"
        ],
        "Advanced": [
            "How would you design a scalable design system for a large product?", "Explain how emotional design influences user behavior.", "How would you optimize UX for enterprise-level applications?", "Why is accessibility compliance important in modern design?", "How would you handle conflicting user feedback?", "Explain advanced prototyping techniques in UI/UX.", "How would you measure UX performance using metrics?", "Why is cross-platform consistency important?", "How would you redesign a product with poor user retention?", "Explain the relationship between UX and business goals.", "How would you improve onboarding experience for new users?", "Why are dark patterns considered unethical in UX?", "How would you conduct large-scale UX research?", "Explain how motion design improves interactions.", "How would you balance innovation with usability in design?"
        ]
    },
    "Full Stack Development": {
        "Beginner": [
            "What is HTML?", "What is the difference between HTML and CSS?", "What is the purpose of JavaScript in web development?", "Difference between `id` and `class` in CSS?", "What is responsive web design?", "What is Flexbox?", "Difference between `let`, `var`, and `const`?", "What is an array in JavaScript?", "What is a function?", "What is DOM manipulation?", "What is React?", "What is JSX?", "What is Node.js?", "What is a database?", "What is CRUD operation?"
        ],
        "Intermediate": [
            "Explain event bubbling in JavaScript.", "What are promises in JavaScript?", "Difference between synchronous and asynchronous programming?", "What is async/await?", "What is localStorage and sessionStorage?", "What is Virtual DOM in React?", "Difference between props and state?", "What is useEffect hook?", "What is middleware in Express.js?", "Explain REST API.", "Difference between GET and POST requests?", "What is JWT authentication?", "Difference between SQL and NoSQL?", "What is schema in MongoDB?", "Explain how frontend communicates with backend."
        ],
        "Advanced": [
            "What is closure in JavaScript?", "Explain hoisting in JavaScript.", "What is the event loop?", "Explain prototypal inheritance.", "What are higher-order functions?", "What is Context API in React?", "Explain Redux and its advantages.", "What is lazy loading in React?", "What is code splitting?", "Explain authentication vs authorization.", "What is CORS and how does it work?", "What is rate limiting in APIs?", "Explain microservices architecture.", "What is Docker and why is it used?", "Explain CI/CD pipeline in deployment."
        ]
    },
    "AI & Machine Learning": {
        "Beginner": [
            "What is Artificial Intelligence?", "What is Machine Learning?", "Difference between AI and ML?", "What is Deep Learning?", "What is Data Science?", "What is a dataset?", "What is training data?", "What is supervised learning?", "What is unsupervised learning?", "What is a feature in Machine Learning?", "What is Python used for in AI/ML?", "What is NumPy?", "What is Pandas?", "What is model training?", "What is prediction in Machine Learning?"
        ],
        "Intermediate": [
            "Difference between supervised and unsupervised learning?", "What is classification in Machine Learning?", "What is regression?", "What is overfitting?", "What is underfitting?", "What is accuracy in Machine Learning?", "What is train-test split?", "What is feature engineering?", "What is Scikit-learn?", "What is TensorFlow?", "What is a neural network?", "What is an epoch in Deep Learning?", "What is loss function?", "Difference between AI, ML, and Deep Learning?", "Explain the working of a chatbot."
        ],
        "Advanced": [
            "What is backpropagation in neural networks?", "Explain gradient descent.", "What is reinforcement learning?", "What is transfer learning?", "What is NLP (Natural Language Processing)?", "What is CNN in Deep Learning?", "What is RNN?", "Difference between CNN and RNN?", "What is hyperparameter tuning?", "What is bias-variance tradeoff?", "What is model optimization?", "Explain precision, recall, and F1-score.", "What is Generative AI?", "What is LLM (Large Language Model)?", "How would you deploy an AI model into a real-world application?"
        ]
    }
};

const fallbackInterviewQuestions = {
    technical: [
        'Describe a recent technical challenge you solved and the steps you took to resolve it.',
        'Explain a situation where you had to choose between several competing technical approaches.',
        'How do you keep your code maintainable and easy to understand as a project grows?',
        'What is your approach to debugging a difficult production issue?'
    ],
    behavioral: [
        'Tell me about a time you worked with a difficult teammate and how you handled it.',
        'Describe a project where you had to learn something new quickly.',
        'How do you manage your time when multiple deadlines overlap?',
        'What motivates you to keep improving your skills as a developer?'
    ]
};

async function callGemini(prompt) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is not configured in your .env file.');
    }

    try {
        const response = await axios.post(GEMINI_URL, {
            contents: [{ parts: [{ text: prompt }] }]
        });
        return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        console.error('Gemini API call failed:', errorMessage);
        throw new Error(`AI generation failed: ${errorMessage}`);
    }
}

function getFallbackInterviewQuestion(role, difficulty, questionNumber, course, interviewType) {
    const roundType = questionNumber <= 2 ? 'technical' : 'behavioral';
    const list = fallbackInterviewQuestions[roundType] || fallbackInterviewQuestions.technical;
    const base = list[(questionNumber - 1) % list.length];
    return `${base} [Focus: ${course} · ${interviewType}]`;
}

function getFallbackInterviewReport(role, difficulty, qaData, course, interviewType) {
    const averageScore = qaData.length > 0
        ? (qaData.reduce((sum, qa) => sum + parseFloat(qa.question_score || 7), 0) / qaData.length).toFixed(1)
        : '7.0';

    return `Overall Assessment:\nYou demonstrated a solid understanding of ${role} concepts at the ${difficulty} level. Your answers were clear and practical, and the interview showed good problem-solving and communication skills.\n\nKey Strengths:\n- Clear and structured answers\n- Good practical reasoning\n- Strong communication\n\nAreas for Improvement:\n- Add more specific examples to technical answers\n- Dive deeper into system design and tradeoffs\n- Clarify your decision-making process when comparing options\n\nRecommendations:\n- Practice explaining your reasoning step-by-step\n- Review core concepts for your selected role\n- Keep answers concise and focused on impact\n\nFinal Score: ${averageScore}/10`;
}

// Generate interview questions dynamically using AI
async function generateInterviewQuestionAI(role, difficulty, questionNumber, previousAnswers = [], interviewType = 'Technical', course = 'General') {
    // Check if we have a curated question first
    const normalizedCourse = normalizeCourseName(course);
    const bank = CURATED_QUESTION_BANK[normalizedCourse];
    if (bank && bank[difficulty] && bank[difficulty][questionNumber - 1]) {
        return bank[difficulty][questionNumber - 1];
    }

    const contextPrompt = previousAnswers.length > 0 
        ? `We are in the middle of a session. Previous Q&A:\n${previousAnswers.map(qa => `Q: ${qa.q}\nA: ${qa.a}`).join('\n\n')}\n\n`
        : '';

    const roundType = questionNumber <= 2 ? 'Technical' : 'HR/Behavioral';

    const prompt = `You are a professional interviewer at a top tech company. Generate a single ${roundType} interview question for a ${difficulty} level ${role} candidate (Question ${questionNumber} of 15).
${contextPrompt}
Requirements:
- For Technical rounds: Ask about specific concepts, problem-solving, or system design related to ${role} and the field of ${course}.
- For HR rounds: Ask about teamwork, challenges, or career goals.
- If the user's previous answer was brief, ask a follow-up to dig deeper.
- Return ONLY the question text. Do not include labels like "Question:" or "AI:".`;

    try {
        const question = await callGemini(prompt);
        return question.trim();
    } catch (err) {
        console.error('AI question generation failed, using fallback question:', err.message);
        return getFallbackInterviewQuestion(role, difficulty, questionNumber, course, interviewType);
    }
}

// Evaluate answer using AI
async function evaluateAnswerAI(question, answer, role, difficulty, interviewType = 'Technical', course = 'General') {
    const prompt = `You are an interview evaluator for a ${course} ${interviewType} role. Evaluate the answer on a scale of 0-10.

Role: ${role}
Difficulty: ${difficulty}
Course: ${course}
Question: ${question}
Answer: ${answer}

Provide JSON response with this structure only (no markdown, pure JSON):
{
  "score": <0-10>,
  "confidence": "<low|medium|high>",
  "communication": "<poor|average|good|excellent>",
  "technical_accuracy": "<poor|average|good|excellent>",
  "brief_feedback": "<one sentence feedback>"
}`;

    try {
        const responseText = await callGemini(prompt);
        // Extract JSON from response
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (err) {
        console.error('Evaluation error:', err);
    }

    return {
        score: 5,
        confidence: 'medium',
        communication: 'average',
        technical_accuracy: 'average',
        brief_feedback: 'Answer received and noted.'
    };
}

// Generate final interview report
async function generateInterviewReportAI(role, difficulty, qaData, interviewType = 'Technical', course = 'General') {
    const qaText = qaData.map((qa, i) => 
        `Q${i+1} (Score: ${qa.question_score}/10): ${qa.question}\nAnswer: ${qa.user_answer}\nFeedback: ${qa.ai_evaluation}`
    ).join('\n\n');

    const prompt = `You are a professional interviewer. Generate a comprehensive feedback report for a ${course} ${interviewType} interview.

Interview Details:
Role: ${role}
Course: ${course}
Difficulty: ${difficulty}
Average Score: ${(qaData.reduce((sum, qa) => sum + parseFloat(qa.question_score || 0), 0) / qaData.length).toFixed(2)}/10

Q&A Summary:
${qaText}

Generate a detailed report with:
1. Overall Assessment (2-3 sentences)
2. Key Strengths (3-4 bullet points)
3. Areas for Improvement (3-4 bullet points)
4. Specific Recommendations (3-4 actionable tips)

Format as plain text with clear sections.`;

    try {
        return await callGemini(prompt);
    } catch (err) {
        console.error('Interview report generation failed, using fallback report:', err.message);
        return getFallbackInterviewReport(role, difficulty, qaData, course, interviewType);
    }
}

// Legacy AI interview API routes removed.
// The project2 interview UI now uses simplified /start-interview, /next-question, and /evaluate-answer endpoints.

// ─── NEW ROUTES FOR INTERVIEW.JS ───

app.post('/start-interview', authenticateToken, async (req, res) => {
    try {
        const { role, difficulty, type, course } = req.body;
        if (!role || !difficulty || !type || !course) {
            return res.status(400).json({ success: false, message: 'Missing interview setup values.' });
        }

        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Authentication required.' });

        const sessionId = `sess_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        const greeting = `Hello! I'm Alex, your AI interviewer from Nexlify. Today we'll be conducting a ${type} interview for the ${role} position in ${course} at the ${difficulty} level. Are you ready to begin?`;

        const insertResult = await dbQuery(
            'INSERT INTO ai_interview_sessions (session_id, user_id, role, difficulty, total_questions, current_question, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [sessionId, userId, role, difficulty, 15, 1, 'ongoing']
        );

        const firstQuestion = await generateInterviewQuestionAI(role, difficulty, 1, [], type, course);
        await dbQuery(
            'INSERT INTO ai_interview_qa (session_id, question_number, question) VALUES (?, ?, ?)',
            [insertResult.insertId, 1, firstQuestion]
        );

        res.json({
            sessionId,
            sessionDbId: insertResult.insertId,
            greeting,
            firstQuestion
        });
    } catch (err) {
        console.error('Start interview error:', err);
        res.status(500).json({ success: false, message: 'Failed to start interview' });
    }
});

app.post('/next-question', authenticateToken, async (req, res) => {
    try {
        const { sessionId, userAnswer, questionCount, role, difficulty, type, course } = req.body;
        if (!sessionId || !userAnswer) {
            return res.status(400).json({ success: false, message: 'Missing session or answer.' });
        }

        const sessions = await dbQuery('SELECT * FROM ai_interview_sessions WHERE session_id = ? AND user_id = ?', [sessionId, req.user.id]);
        const session = Array.isArray(sessions) ? sessions[0] : null;
        if (!session) return res.status(404).json({ success: false, message: 'Interview session not found.' });

        const questionNumber = parseInt(questionCount, 10);
        const previousRow = await dbQuery('SELECT * FROM ai_interview_qa WHERE session_id = ? AND question_number = ?', [session.id, questionNumber]);
        if (!previousRow || previousRow.length === 0) {
            return res.status(400).json({ success: false, message: 'Previous question not found.' });
        }

        const lastQuestion = previousRow[0];
        const evaluation = await evaluateAnswerAI(lastQuestion.question, userAnswer, role, difficulty, type, course);
        await dbQuery(
            'UPDATE ai_interview_qa SET user_answer = ?, question_score = ?, ai_evaluation = ?, confidence_level = ?, communication_quality = ?, technical_accuracy = ? WHERE id = ?',
            [userAnswer, evaluation.score || 0, evaluation.brief_feedback || '', evaluation.confidence || '', evaluation.communication || '', evaluation.technical_accuracy || '', lastQuestion.id]
        );

        const answeredRows = await dbQuery('SELECT question, user_answer FROM ai_interview_qa WHERE session_id = ? AND question_number <= ? ORDER BY question_number', [session.id, questionNumber]);
        const previousAnswers = Array.isArray(answeredRows)
            ? answeredRows.map(q => ({ q: q.question, a: q.user_answer || '' }))
            : [];

        if (questionNumber >= 15) {
            await dbQuery('UPDATE ai_interview_sessions SET status = ?, current_question = ?, end_time = ?, total_score = ? WHERE id = ?', ['completed', questionNumber, new Date(), evaluation.score || 0, session.id]);
            return res.json({ done: true });
        }

        const nextNumber = questionNumber + 1;
        const nextQuestion = await generateInterviewQuestionAI(role, difficulty, nextNumber, previousAnswers, type, course);
        await dbQuery('INSERT INTO ai_interview_qa (session_id, question_number, question) VALUES (?, ?, ?)', [session.id, nextNumber, nextQuestion]);
        await dbQuery('UPDATE ai_interview_sessions SET current_question = ? WHERE id = ?', [nextNumber, session.id]);

        res.json({ question: nextQuestion, done: false });
    } catch (err) {
        console.error('Next question error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch next question.' });
    }
});

app.post('/evaluate-answer', authenticateToken, async (req, res) => {
    try {
        const { sessionId, role, difficulty, type, course, duration } = req.body;
        console.log(`[EVALUATE] Received request for session: ${sessionId}, user: ${req.user.id}`);
        if (!sessionId || !role || !difficulty || !type || !course) {
            console.error(`[EVALUATE] Missing evaluation parameters for session ${sessionId}`);
            return res.status(400).json({ success: false, message: 'Missing evaluation parameters.' });
        }

        const sessions = await dbQuery('SELECT * FROM ai_interview_sessions WHERE session_id = ? AND user_id = ?', [sessionId, req.user.id]);
        const session = Array.isArray(sessions) ? sessions[0] : null;
        if (!session) {
            console.error(`[EVALUATE] Session ${sessionId} not found for user ${req.user.id}`);
            return res.status(404).json({ success: false, message: 'Interview session not found.' });
        }
        console.log(`[EVALUATE] Session found: ${session.id}`);

        const qaRows = await dbQuery('SELECT * FROM ai_interview_qa WHERE session_id = ? ORDER BY question_number', [session.id]);
        if (!Array.isArray(qaRows) || qaRows.length === 0) {
            console.error(`[EVALUATE] No Q&A data found for session ${session.id}`);
            return res.status(400).json({ success: false, message: 'No interview answers found.' });
        }
        console.log(`[EVALUATE] Found ${qaRows.length} Q&A entries.`);

        const qaData = qaRows.map(row => ({
            question: row.question,
            user_answer: row.user_answer || 'No answer provided.',
            question_score: parseFloat(row.question_score || 7),
            ai_evaluation: row.ai_evaluation || 'No evaluation available.'
        }));

        console.log(`[EVALUATE] Calling generateInterviewReportAI for session ${session.id}`);
        const report = await generateInterviewReportAI(role, difficulty, qaData, type, course);
        console.log(`[EVALUATE] Report generated (length: ${report.length}):\n${report.substring(0, 500)}...`); // Log first 500 chars

        const strengths = report.match(/Strengths:?([\s\S]*?)(?=Areas|Recommendations|$)/i)?.[1].split('\n').filter(s => s.trim().length > 5) || ['Good communication'];
        const weaknesses = report.match(/Areas for Improvement:?([\s\S]*?)(?=Recommendations|$)/i)?.[1].split('\n').filter(s => s.trim().length > 5) || ['Could provide more technical depth'];
        const suggestions = report.match(/Recommendations:?([\s\S]*)/i)?.[1].split('\n').filter(s => s.trim().length > 5) || ['Keep practicing your coding fundamentals'];

        console.log(`[EVALUATE] Parsed strengths: ${JSON.stringify(strengths)}`);
        console.log(`[EVALUATE] Parsed weaknesses: ${JSON.stringify(weaknesses)}`);
        console.log(`[EVALUATE] Parsed suggestions: ${JSON.stringify(suggestions)}`);

        const avgScore = qaData.reduce((sum, qa) => sum + (parseFloat(qa.question_score) || 7), 0) / qaData.length;
        const technicalScore = Math.min(10, Math.max(0, avgScore + 0.4));
        const communicationScore = Math.min(10, Math.max(0, avgScore - 0.2));
        const confidenceScore = Math.min(10, Math.max(0, avgScore + 0.2));
        const overallScore = Math.min(10, Math.max(0, avgScore));
        const interviewScore = Math.round(overallScore * 10);
        console.log(`[EVALUATE] Scores calculated. Overall: ${overallScore}`);

        await dbQuery(
            'INSERT INTO interview_results (interview_id, user_id, course, questions, answers, score, feedback) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [sessionId, req.user.id, course, JSON.stringify(qaData.map(q => q.question)), JSON.stringify(qaData.map(q => q.user_answer)), interviewScore, report]
        );

        await dbQuery('UPDATE ai_interview_sessions SET status = ?, end_time = ?, total_score = ? WHERE id = ?', ['completed', new Date(), overallScore, session.id]);
        console.log(`[EVALUATE] Updated ai_interview_sessions status.`);

        res.json({
            technicalScore: Number(technicalScore).toFixed(1),
            communicationScore: Number(communicationScore).toFixed(1),
            confidenceScore: Number(confidenceScore).toFixed(1),
            overallScore: Number(overallScore).toFixed(1),
            strengths: strengths.slice(0, 3).map(s => s.replace(/^[*-]\s*/, '').trim()),
            weaknesses: weaknesses.slice(0, 3).map(s => s.replace(/^[*-]\s*/, '').trim()),
            suggestions: suggestions.slice(0, 3).map(s => s.replace(/^[*-]\s*/, '').trim()),
            reportText: report
        });
        console.log(`[EVALUATE] Response sent for session ${sessionId}.`);
    } catch (err) {
        console.error('Evaluation error:', err);
        res.status(500).json({ success: false, message: 'Failed to evaluate interview.' });
    }
});

app.get('/api/admin/interview-results/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const rows = await dbQuery(
            `SELECT r.id, r.interview_id, u.name AS student_name, u.email, r.course, r.score, r.feedback, r.questions, r.answers, r.created_at
             FROM interview_results r
             JOIN users u ON u.id = r.user_id
             WHERE r.id = ?`,
            [id]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Interview report not found.' });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('Interview detail error:', err);
        res.status(500).json({ success: false, message: 'Failed to load interview details.' });
    }
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.redirect('/index.html'));

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('\x1b[31m%s\x1b[0m', 'Unhandled Error:', err.stack);
    res.status(500).json({ 
        success: false, 
        message: 'Something went wrong on our end. Please try again later.' 
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log('\x1b[36m%s\x1b[0m', `🚀 Server: http://localhost:${PORT}`);
    console.log('\x1b[33m%s\x1b[0m', `📁 Website: http://localhost:${PORT}/index.html`);
    if (process.env.NODE_ENV !== 'production' && process.platform === 'win32') {
        exec(`start chrome http://localhost:${PORT}/index.html`, (err) => {
            if (err) exec(`start http://localhost:${PORT}/index.html`);
        });
    }
});
