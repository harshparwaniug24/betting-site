const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

// ─────────────────────────────────────────
//  BOT PLAYERS (REMOVED)
// ─────────────────────────────────────────

function randBetween(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(randBetween(a, b + 1)); }

// ─────────────────────────────────────────
//  GAME STATE
// ─────────────────────────────────────────
let gameState = 'waiting';   // waiting | flying | crashed
let multiplier = 1.00;
let crashPoint = 1.00;
let roundStart = 0;           // Date.now() when round started (for e^kt formula)
let gameLoop = null;
let waitTimer = null;
let countdown = 5;
let roundNum = 0;
let history = [];          // last 20 crash points

// k constant: M(t) = e^(k*t)  where t is ms
// At t=10000ms (10s), want ~2x  →  k = ln(2)/10000 ≈ 0.0000693
// At t=30000ms (30s), want ~8x  →  k = ln(8)/30000 ≈ 0.0000693  ✓
const K = Math.log(2) / 10000;   // ~0.0000693 per ms

// Live bets table: [{ id, name, avatar, bet, cashout, win }]
let liveBets = [];

// Queued bets from real players (for mid-round bets)
// { socketId, amount }
let queued = {};

// Real player sessions
const sessions = {};  // socketId -> { wallet, pendingBet, inRound }

// ─────────────────────────────────────────
//  CRASH POINT GENERATOR (FAIR ALGORITHM)
// ─────────────────────────────────────────
const HOUSE_EDGE = 0.03; // 3% House Edge

function generateCrashPoint() {
    // Standard provably fair / random algorithm used in crypto crash games.
    const r = Math.random();
    // Formula: (1 - Edge) / random
    const crash = (1 - HOUSE_EDGE) / r;
    // Cap minimum to 1.00 so house maintains absolute edge at lowest bound
    return parseFloat(Math.max(1.00, crash).toFixed(2));
}

// Real bets array initialization will occur dynamically.

// ─────────────────────────────────────────
//  ROUND LIFECYCLE
// ─────────────────────────────────────────
function startRound() {
    if (gameLoop) clearInterval(gameLoop);
    if (waitTimer) clearInterval(waitTimer);

    roundNum++;
    gameState = 'flying';
    multiplier = 1.00;
    crashPoint = generateCrashPoint();
    roundStart = Date.now();

    console.log(`🚀 Round #${roundNum} — crash at ${crashPoint}x`);

    // Add queued real bets to liveBets
    Object.entries(queued).forEach(([sid, amount]) => {
        const sess = sessions[sid];
        if (!sess) return;
        if (amount > sess.wallet) return;
        sess.wallet -= amount;
        sess.inRound = true;
        sess.pendingBet = amount;
        liveBets.push({ id: sid, name: 'You', avatar: '🎮', bet: amount, cashout: null, win: null, isBot: false });
    });
    queued = {};

    // No bot spawning here
    io.emit('roundStart', { round: roundNum });
    io.emit('liveBets', liveBets);

    // Notify queued players their bet was placed
    Object.keys(sessions).forEach(sid => {
        if (sessions[sid].inRound) {
            io.to(sid).emit('betConfirmed', sessions[sid].pendingBet);
        }
    });

    gameLoop = setInterval(() => {
        const elapsed = Date.now() - roundStart;
        multiplier = parseFloat((Math.exp(K * elapsed)).toFixed(2));

        io.emit('multiplier', multiplier);

        if (multiplier >= crashPoint) {
            endRound();
        }
    }, 100);
}

function endRound() {
    clearInterval(gameLoop);
    const finalMult = parseFloat(Math.min(multiplier, crashPoint).toFixed(2));
    multiplier = finalMult;
    gameState = 'crashed';

    console.log(`💥 Crashed at ${finalMult}x`);
    io.emit('crash', finalMult);

    history.unshift(finalMult);
    if (history.length > 20) history.pop();
    io.emit('history', history);

    // Reset real player flags
    Object.values(sessions).forEach(s => { s.inRound = false; s.pendingBet = 0; });

    // Countdown
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
//  SOCKET.IO
// ─────────────────────────────────────────
io.on('connection', socket => {
    console.log(`✅ ${socket.id}`);
    sessions[socket.id] = { wallet: 1000, pendingBet: 0, inRound: false };

    // Sync
    socket.emit('init', {
        gameState, multiplier, history,
        wallet: sessions[socket.id].wallet,
        round: roundNum,
    });
    socket.emit('liveBets', liveBets);
    if (gameState === 'flying') socket.emit('multiplier', multiplier);
    if (gameState === 'waiting') socket.emit('waiting', countdown);

    // Broadcast updated player count
    io.emit('playerCount', io.engine.clientsCount);

    // BET
    socket.on('bet', amount => {
        const sess = sessions[socket.id];
        if (!sess) return;
        const amt = parseFloat(amount);
        if (!amt || amt < 1 || amt > sess.wallet) {
            socket.emit('betError', 'Invalid amount'); return;
        }

        if (gameState === 'waiting') {
            // Immediate: queue for next round (round hasn't started yet so defer)
            queued[socket.id] = amt;
            socket.emit('betQueued', amt);
            console.log(`💰 Queued: ${socket.id} $${amt}`);
        } else if (gameState === 'flying') {
            // Mid-round: queue for NEXT round
            queued[socket.id] = amt;
            socket.emit('betQueued', amt);
            console.log(`💰 Next-round queue: ${socket.id} $${amt}`);
        }
    });

    // CANCEL QUEUED BET
    socket.on('cancelBet', () => {
        delete queued[socket.id];
        socket.emit('betCancelled');
    });

    // CASHOUT
    socket.on('cashout', () => {
        const sess = sessions[socket.id];
        if (!sess || !sess.inRound || gameState !== 'flying') return;

        const win = parseFloat((sess.pendingBet * multiplier).toFixed(2));
        sess.wallet += win;
        sess.inRound = false;

        // Update live bets list
        const entry = liveBets.find(b => b.id === socket.id);
        if (entry) { entry.cashout = multiplier; entry.win = win; }
        io.emit('liveBets', liveBets);

        socket.emit('cashedOut', { mult: multiplier, win, wallet: sess.wallet });
        console.log(`💸 Cashout: ${socket.id} @ ${multiplier}x → $${win}`);
    });

    socket.on('disconnect', () => {
        delete sessions[socket.id];
        delete queued[socket.id];
        console.log(`❌ ${socket.id}`);
        // Remove from liveBets if they leave
        liveBets = liveBets.filter(b => b.id !== socket.id);
        io.emit('liveBets', liveBets);
        // Broadcast updated player count
        io.emit('playerCount', io.engine.clientsCount);
    });
});

// ─────────────────────────────────────────
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`\n🎯 Aviator → http://localhost:${PORT}\n`);
    setTimeout(startRound, 2000);
});