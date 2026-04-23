require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const twilio = require('twilio');
const cricketService = require('./services/cricketService');

// Initialize Twilio
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID || 'AC_dummy_sid',
    process.env.TWILIO_AUTH_TOKEN || 'dummy_token'
);

function formatE164(mobile) {
    let cleaned = mobile.replace(/[^\d+]/g, '');
    if (!cleaned.startsWith('+')) {
        if (cleaned.length === 10) cleaned = '+91' + cleaned;
        else cleaned = '+' + cleaned;
    }
    return cleaned;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json({ limit: '10mb' })); // Higher limit for base64 QR
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const sessionMiddleware = session({
    secret: 'aviator-super-secret-key-123!',
    resave: false,
    saveUninitialized: false
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// Logger Middleware
app.use((req, res, next) => {
    if (req.url.startsWith('/api')) {
        console.log(`[API] ${req.method} ${req.url} - Session: ${req.session && req.session.user ? req.session.user.username : 'Guest/None'}`);
    }
    next();
});

// ─────────────────────────────────────────
//  DATABASE SETUP
// ─────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'users.json');
let users = [];
if (!fs.existsSync(path.dirname(DB_PATH))) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
if (fs.existsSync(DB_PATH)) {
    try { users = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } catch (e) { }
} else {
    fs.writeFileSync(DB_PATH, '[]');
}

function saveDB() {
    fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

// ─────────────────────────────────────────
//  BANKING STORAGE
// ─────────────────────────────────────────
let bankingRequests = [];
try {
    if (!fs.existsSync('data')) fs.mkdirSync('data');
    if (fs.existsSync('data/requests.json')) {
        bankingRequests = JSON.parse(fs.readFileSync('data/requests.json'));
    }
} catch (e) { console.error('Error loading requests.json', e); }

function saveRequests() {
    fs.writeFileSync('data/requests.json', JSON.stringify(bankingRequests, null, 2));
}

// ─────────────────────────────────────────
//  AUTHENTICATION APIs
// ─────────────────────────────────────────
const pendingVerifications = {};

app.post('/api/register', async (req, res) => {
    const { username, password, mobile } = req.body;
    if (!username || !password || !mobile) return res.status(400).json({ error: 'Missing fields' });
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username already taken' });
    if (users.find(u => u.mobile === mobile)) return res.status(400).json({ error: 'Mobile number already registered' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hash = crypto.createHash('sha256').update(otp).digest('hex');

    pendingVerifications[mobile] = {
        hash,
        expiresAt: Date.now() + 5 * 60 * 1000,
        tempUser: { id: Date.now().toString(), username, password, mobile, balance: 0.00 }
    };

    console.log(`[OTP GENERATED] mobile: ${mobile} | otp: ${otp}`);

    try {
        if (process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('AC_dummy')) {
            await twilioClient.messages.create({
                body: `Your Aviator verification code is: ${otp}`,
                from: process.env.TWILIO_PHONE_NUMBER || '+1234567890',
                to: formatE164(mobile)
            });
            res.json({ success: true, message: 'OTP Sent' });
        } else {
            console.log(`[DEMO MODE] Skip sending SMS. OTP: ${otp}`);
            res.json({ success: true, message: 'OTP Generated (Check server console)' });
        }
    } catch (err) {
        console.error('Twilio Error:', err.message);
        res.status(500).json({ success: false, error: `Failed to send SMS: ${err.message}` });
    }
});

app.post('/api/verify-otp', (req, res) => {
    const { mobile, otp } = req.body;
    const pending = pendingVerifications[mobile];
    if (!pending || Date.now() > pending.expiresAt) return res.status(400).json({ error: 'OTP Expired or Missing' });

    const inputHash = crypto.createHash('sha256').update(otp).digest('hex');
    if (inputHash === pending.hash) {
        users.push(pending.tempUser);
        saveDB();
        delete pendingVerifications[mobile];
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Invalid OTP' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    req.session.user = { id: user.id, username: user.username };
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const user = users.find(u => u.id === req.session.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, mobile: user.mobile, balance: user.balance });
});

// ─────────────────────────────────────────
//  BANKING APIs
// ─────────────────────────────────────────
app.post('/api/deposit', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const { amount } = req.body;
    const user = users.find(u => u.id === req.session.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const request = { id: Date.now(), type: 'DEPOSIT', userId: user.id, username: user.username, amount: parseFloat(amount), time: Date.now(), status: 'PENDING' };
    bankingRequests.push(request);
    saveRequests();
    console.log(`[BANKING] Deposit request for ${user.username} saved.`);
    res.json({ success: true });
});

app.post('/api/withdraw', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const { amount, details } = req.body;
    const user = users.find(u => u.id === req.session.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const request = { id: Date.now(), type: 'WITHDRAW', userId: user.id, username: user.username, amount: parseFloat(amount), details, time: Date.now(), status: 'PENDING' };
    bankingRequests.push(request);
    saveRequests();
    console.log(`[BANKING] Withdraw request for ${user.username} saved.`);
    res.json({ success: true });
});

app.get('/api/admin/banking', (req, res) => {
    res.json(bankingRequests.filter(r => r.status === 'PENDING'));
});

app.post('/api/admin/approve-banking', (req, res) => {
    const { requestId, action } = req.body;
    const reqIndex = bankingRequests.findIndex(r => r.id === requestId);
    if (reqIndex === -1) return res.status(404).json({ error: 'Request not found' });
    const bReq = bankingRequests[reqIndex];
    if (bReq.status !== 'PENDING') return res.status(400).json({ error: 'Request already processed' });

    if (action === 'APPROVE') {
        const user = users.find(u => u.id === bReq.userId);
        if (user) {
            if (bReq.type === 'DEPOSIT') {
                user.balance += bReq.amount;
                if (!user.transactions) user.transactions = [];
                user.transactions.push({ type: 'DEPOSIT_APPROVED', amount: bReq.amount, time: Date.now() });
            } else {
                user.balance -= bReq.amount;
                if (!user.transactions) user.transactions = [];
                user.transactions.push({ type: 'WITHDRAWAL', amount: -bReq.amount, time: Date.now() });
            }
            saveDB();
        }
        bReq.status = 'APPROVED';
    } else {
        bReq.status = 'REJECTED';
    }
    saveRequests();
    res.json({ success: true });
});

app.post('/api/admin/upload-qr', (req, res) => {
    const { image } = req.body;
    if (!image) {
        console.error('[UPLOAD] No image data received');
        return res.status(400).json({ error: 'No image data' });
    }

    try {
        console.log(`[UPLOAD] Receiving image data (${(image.length / 1024).toFixed(2)} KB)`);
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
            console.log('[UPLOAD] Created uploads directory');
        }

        fs.writeFileSync(path.join(uploadsDir, 'admin_qr.png'), base64Data, 'base64');
        console.log('[UPLOAD] Successfully saved admin_qr.png');
        res.json({ success: true });
    } catch (e) {
        console.error('[UPLOAD ERROR]', e);
        res.status(500).json({ error: 'Failed to save image: ' + e.message });
    }
});

app.get('/api/admin/users', (req, res) => {
    res.json(users.map(u => ({ id: u.id, username: u.username, balance: u.balance, mobile: u.mobile })));
});

app.post('/api/admin/add-balance', (req, res) => {
    const { username, amount } = req.body;
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.balance += parseFloat(amount);
    if (!user.transactions) user.transactions = [];
    user.transactions.push({ type: 'MANUAL_ADD', amount: parseFloat(amount), time: Date.now() });
    saveDB();
    res.json({ success: true, newBalance: user.balance });
});

// Profile & Account
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.post('/api/change-password', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const { oldPass, newPass } = req.body;

    // Regex: 1 upper, 1 lower, 1 digit, 1 special, min 8 chars
    const passRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passRegex.test(newPass)) {
        return res.status(400).json({ error: 'Password must have 1 uppercase, 1 lowercase, 1 number, 1 special char and be 8+ chars long.' });
    }

    const user = users.find(u => u.id === req.session.user.id);
    if (!user || user.password !== oldPass) return res.status(400).json({ error: 'Current password incorrect' });
    user.password = newPass;
    saveDB();
    res.json({ success: true });
});

app.get('/api/statement', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const user = users.find(u => u.id === req.session.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ transactions: (user.transactions || []).slice(-20).reverse() });
});

app.get('/api/odds', async (req, res) => {
    const odds = await cricketService.getOdds();
    res.json(odds);
});

// ─────────────────────────────────────────
//  STATIC FILES
// ─────────────────────────────────────────
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─────────────────────────────────────────
//  GAME LOGIC
// ─────────────────────────────────────────
const HOUSE_EDGE = 0.03;
const K = Math.log(2) / 10000;

let gameState = 'waiting';
let multiplier = 1.00;
let crashPoint = 1.00;
let roundStart = 0;
let gameLoop = null;
let waitTimer = null;
let countdown = 5;
let roundNum = 0;
let history = [];
let liveBets = [];
let queued = {};
const sessions = {};

function generateCrashPoint() {
    const r = Math.random();
    const crash = (1 - HOUSE_EDGE) / r;
    return parseFloat(Math.max(1.00, crash).toFixed(2));
}

function startRound() {
    if (gameLoop) clearInterval(gameLoop);
    if (waitTimer) clearInterval(waitTimer);
    roundNum++;
    gameState = 'flying';
    multiplier = 1.00;
    crashPoint = generateCrashPoint();
    roundStart = Date.now();
    console.log(`🚀 Round #${roundNum} — crash at ${crashPoint}x`);

    Object.entries(queued).forEach(([sid, amount]) => {
        const sess = sessions[sid];
        if (!sess) return;
        const userDb = users.find(u => u.id === sess.userId);
        if (!userDb || amount > sess.wallet) return;
        sess.wallet -= amount;
        userDb.balance = sess.wallet;
        if (!userDb.transactions) userDb.transactions = [];
        userDb.transactions.push({ type: 'BET', amount: -amount, time: Date.now() });
        saveDB();
        sess.inRound = true;
        sess.pendingBet = amount;
        liveBets.push({ id: sid, name: sess.username, avatar: '👤', bet: amount, cashout: null, win: null });
    });
    queued = {};

    io.emit('roundStart', { round: roundNum });
    io.emit('liveBets', liveBets);

    gameLoop = setInterval(() => {
        multiplier = parseFloat((Math.exp(K * (Date.now() - roundStart))).toFixed(2));
        io.emit('multiplier', multiplier);
        if (multiplier >= crashPoint) endRound();
    }, 100);
}

function endRound() {
    clearInterval(gameLoop);
    const finalMult = parseFloat(Math.min(multiplier, crashPoint).toFixed(2));
    gameState = 'crashed';
    console.log(`💥 Crashed at ${finalMult}x`);
    io.emit('crash', finalMult);
    history.unshift(finalMult);
    if (history.length > 20) history.pop();
    io.emit('history', history);
    Object.values(sessions).forEach(s => { s.inRound = false; s.pendingBet = 0; });
    gameState = 'waiting';
    countdown = 5;
    io.emit('waiting', countdown);
    waitTimer = setInterval(() => {
        countdown--;
        if (countdown > 0) io.emit('countdown', countdown);
        if (countdown <= 0) { clearInterval(waitTimer); startRound(); }
    }, 1000);
}

// ─────────────────────────────────────────
//  CRICKET BROADCAST
// ─────────────────────────────────────────
app.post('/api/place-cricket-bet', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Please login to bet' });
    const { amount, matchId, selection } = req.body;
    const user = users.find(u => u.id === req.session.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    user.balance -= amount;
    if (!user.transactions) user.transactions = [];
    user.transactions.push({
        type: `Cricket Bet (${selection})`,
        amount: -amount,
        time: Date.now()
    });
    saveDB();
    res.json({ success: true, balance: user.balance });
});

// Broadcast odds every 1s
setInterval(async () => {
    const odds = await cricketService.getOdds();
    io.emit('cricketUpdate', odds);
}, 1000); // Broadcast every 1s

// ─────────────────────────────────────────
//  SOCKET.IO
// ─────────────────────────────────────────
io.on('connection', socket => {
    console.log(`[SOCKET] New connection attempt: ${socket.id}`);
    const reqSession = socket.request.session;
    let userId = null, username = 'Guest', balance = 0;

    if (reqSession && reqSession.user) {
        userId = reqSession.user.id;
        const userDb = users.find(u => u.id === userId);
        if (userDb) { username = userDb.username; balance = userDb.balance; }
    }

    sessions[socket.id] = { userId, username, wallet: balance, pendingBet: 0, inRound: false, isGuest: !userId };

    socket.emit('init', { gameState, multiplier, history, wallet: balance, round: roundNum, isGuest: !userId });
    socket.emit('liveBets', liveBets);
    io.emit('playerCount', io.engine.clientsCount);

    socket.on('bet', amount => {
        const sess = sessions[socket.id];
        if (!sess || sess.isGuest) return socket.emit('betError', 'Authentication required');
        const amt = parseFloat(amount);
        if (!amt || amt < 1 || amt > sess.wallet) return socket.emit('betError', 'Invalid amount');
        queued[socket.id] = amt;
        socket.emit('betQueued', amt);
    });

    socket.on('cashout', () => {
        const sess = sessions[socket.id];
        if (!sess || !sess.inRound || gameState !== 'flying') return;
        const win = parseFloat((sess.pendingBet * multiplier).toFixed(2));
        sess.wallet += win;
        const userDb = users.find(u => u.id === sess.userId);
        if (userDb) {
            userDb.balance = sess.wallet;
            if (!userDb.transactions) userDb.transactions = [];
            userDb.transactions.push({ type: 'WIN', amount: win, multiplier, time: Date.now() });
            saveDB();
        }
        sess.inRound = false;
        const entry = liveBets.find(b => b.id === socket.id);
        if (entry) { entry.cashout = multiplier; entry.win = win; }
        io.emit('liveBets', liveBets);
        socket.emit('cashedOut', { mult: multiplier, win, wallet: sess.wallet });
    });

    socket.on('disconnect', () => {
        delete sessions[socket.id]; delete queued[socket.id];
        liveBets = liveBets.filter(b => b.id !== socket.id);
        io.emit('liveBets', liveBets);
        io.emit('playerCount', io.engine.clientsCount);
    });
});

// Initialize the first waiting countdown when the server starts.
// Without this, the game never enters the first round on fresh boot.
function initGameCycle() {
    if (waitTimer) clearInterval(waitTimer);
    gameState = 'waiting';
    countdown = 5;
    io.emit('waiting', countdown);
    io.emit('countdown', countdown);
    waitTimer = setInterval(() => {
        countdown--;
        if (countdown > 0) io.emit('countdown', countdown);
        if (countdown <= 0) {
            clearInterval(waitTimer);
            startRound();
        }
    }, 1000);
}

initGameCycle();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
