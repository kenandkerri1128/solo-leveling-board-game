const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Supabase Configuration
const SUPABASE_URL = 'https://wfsuxqgvshrhqfvnkzdx.supabase.co'; 
const SUPABASE_KEY = 'sb_publishable_gV-RZMfBZ1dLU60Ht4J9iw_-sRWSKnL'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.static(path.join(__dirname, 'public')));

// TRACKING
let rooms = {};
let connectedUsers = {}; 
let adminSocketId = null;
let recentAdminMessages = [];

// CONFIGURATION
const ADMIN_NAME = "Kei"; 
const AI_NAMES = ["Sung Jinwoo", "Cha Hae-In", "Baek Yoonho", "Choi Jong-In"];
const PLAYER_COLORS = ['#00d2ff', '#ff3e3e', '#bcff00', '#ff00ff']; 
const RANK_COLORS = { 'E': '#00ff00', 'D': '#99ff00', 'C': '#ffff00', 'B': '#ff9900', 'A': '#ff00ff', 'S': '#ff0000', 'Silver': '#ffffff' };
const POWER_UPS = ['DOUBLE DAMAGE', 'GHOST WALK', 'NETHER SWAP'];

// --- RANKING HELPERS ---
function getFullRankLabel(val) {
    if (val >= 1000) return "Higher S-Rank";
    if (val >= 901) return "Lower S-Rank";
    if (val >= 801) return "Higher A-Rank";
    if (val >= 701) return "Lower A-Rank";
    if (val >= 601) return "Higher B-Rank";
    if (val >= 501) return "Lower B-Rank";
    if (val >= 401) return "Higher C-Rank";
    if (val >= 301) return "Lower C-Rank";
    if (val >= 201) return "Higher D-Rank";
    if (val >= 101) return "Lower D-Rank";
    if (val >= 51) return "Higher E-Rank";
    return "Lower E-Rank";
}

function getDisplayRank(mana) {
    if (mana >= 901) return "Rank S";
    if (mana >= 701) return "Rank A";
    if (mana >= 501) return "Rank B";
    if (mana >= 301) return "Rank C";
    if (mana >= 101) return "Rank D";
    return "Rank E"; 
}

function getSimpleRank(val) {
    if (val >= 901) return 'S';
    if (val >= 701) return 'A';
    if (val >= 501) return 'B';
    if (val >= 301) return 'C';
    if (val >= 101) return 'D';
    return 'E';
}

async function getWorldRankDisplay(username) {
    const { data } = await supabase.from('Hunters').select('username, hunterpoints').order('hunterpoints', { ascending: false });
    if (!data) return { label: '#??', color: '#888' };
    const index = data.findIndex(u => u.username === username);
    if (index === -1) return { label: '#??', color: '#888' };
    const rank = index + 1;
    let color = (rank <= 3) ? '#ffcc00' : ((rank <= 10) ? '#ff003c' : '#fff'); 
    return { label: `#${rank}`, color: color };
}

async function broadcastWorldRankings() {
    const { data } = await supabase.from('Hunters').select('username, hunterpoints, wins, losses').order('hunterpoints', { ascending: false }).limit(100);
    if (data) {
        const formatted = data.map(r => ({ ...r, rankLabel: getFullRankLabel(r.hunterpoints), isAdmin: r.username === ADMIN_NAME }));
        io.emit('updateWorldRankings', formatted);
    }
}

async function sendProfileUpdate(socket, username) {
    const { data: user } = await supabase.from('Hunters').select('*').eq('username', username).maybeSingle();
    if (user) {
        const { count } = await supabase.from('Hunters').select('*', { count: 'exact', head: true }).gt('hunterpoints', user.hunterpoints);
        const letter = getSimpleRank(user.hunterpoints);
        socket.emit('authSuccess', { 
            username: user.username, mana: user.hunterpoints, rank: getFullRankLabel(user.hunterpoints), color: RANK_COLORS[letter],
            wins: user.wins || 0, losses: user.losses || 0, worldRank: (count || 0) + 1, isAdmin: (user.username === ADMIN_NAME)
        });
    }
}

// --- GAME LOGIC HELPERS ---
async function recordLoss(username, winnerInGameMana) {
    const { data: u } = await supabase.from('Hunters').select('hunterpoints, losses').eq('username', username).maybeSingle();
    if (u) {
        const mpStr = winnerInGameMana.toString();
        let deduction = (winnerInGameMana >= 10000) ? parseInt(mpStr.substring(0, 2)) : parseInt(mpStr.substring(0, 1));
        await supabase.from('Hunters').update({ hunterpoints: Math.max(0, u.hunterpoints - Math.max(1, deduction)), losses: (u.losses || 0) + 1 }).eq('username', username);
    }
}

async function processWin(room, winnerName) {
    const { data: u } = await supabase.from('Hunters').select('hunterpoints, wins').eq('username', winnerName).maybeSingle();
    if (u) await supabase.from('Hunters').update({ hunterpoints: u.hunterpoints + 20, wins: (u.wins || 0) + 1 }).eq('username', winnerName);
    
    io.to(room.id).emit('victoryEvent', { winner: winnerName });
    room.active = false;
    broadcastWorldRankings();
    const winnerPlayer = room.players.find(p => p.name === winnerName);
    if(winnerPlayer && io.sockets.sockets.get(winnerPlayer.id)) sendProfileUpdate(io.sockets.sockets.get(winnerPlayer.id), winnerName);

    setTimeout(() => { 
        io.to(room.id).emit('returnToProfile'); 
        if(rooms[room.id]) delete rooms[room.id];
        syncAllGates();
    }, 6000); 
}

function syncAllGates() {
    const list = Object.values(rooms).filter(r => r.isOnline && !r.active).map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    io.emit('updateGateList', list);
}

function broadcastGameState(room) { 
    if (!room) return;
    const roomClients = io.sockets.adapter.rooms.get(room.id);
    if (!roomClients) return;
    roomClients.forEach(socketId => {
        const isSpectatingAdmin = (socketId === adminSocketId);
        const sanitizedPlayers = room.players.map(p => ({
            ...p,
            mana: (p.id === socketId || isSpectatingAdmin) ? p.mana : null, 
            powerUp: (p.id === socketId || isSpectatingAdmin) ? p.powerUp : null,
            rankLabel: getFullRankLabel(p.mana), 
            displayRank: getDisplayRank(p.mana)
        }));
        io.to(socketId).emit('gameStateUpdate', { ...room, players: sanitizedPlayers });
    });
}

function isPathBlocked(room, x1, y1, x2, y2) {
    let dx = x2 - x1, dy = y2 - y1, steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps <= 1) return false; 
    for (let i = 1; i < steps; i++) {
        let cx = x1 + Math.round((dx / steps) * i), cy = y1 + Math.round((dy / steps) * i);
        if (room.world[`${cx}-${cy}`]) return true;
    }
    return false;
}

function spawnGate(room) {
    let x, y, tries = 0;
    do { x = Math.floor(Math.random() * 15); y = Math.floor(Math.random() * 15); tries++; } 
    while ((room.players.some(p => p.alive && p.x === x && p.y === y) || room.world[`${x}-${y}`]) && tries < 100);
    const cycle = Math.floor(room.globalTurns / room.players.length);
    let pool = room.respawnHappened ? (cycle >= 6 ? ['A', 'S'] : (cycle >= 3 ? ['B', 'A'] : ['C', 'B'])) : (cycle >= 6 ? ['C', 'B'] : (cycle >= 3 ? ['D', 'C'] : ['E', 'D']));
    const rank = pool[Math.floor(Math.random() * pool.length)];
    const manaMap = { 'E': [0, 100], 'D': [101, 300], 'C': [301, 500], 'B': [501, 700], 'A': [701, 900], 'S': [901, 1200] };
    const range = manaMap[rank];
    room.world[`${x}-${y}`] = { rank, color: RANK_COLORS[rank], mana: Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0] };
}

function triggerRespawn(room, lastPlayerId) {
    const candidates = room.players.filter(p => !p.quit);
    if (candidates.length === 0) { delete rooms[room.id]; return; }
    room.respawnHappened = true; 
    candidates.forEach(pl => { if (pl.id !== lastPlayerId) pl.mana += Math.floor(Math.random() * 1001) + 500; pl.alive = true; });
    room.world = {}; room.globalTurns = 0; room.survivorTurns = 0;
    room.turn = room.players.findIndex(pl => pl.id === lastPlayerId);
    for(let i=0; i<5; i++) spawnGate(room);
    io.to(room.id).emit('announcement', `SYSTEM: QUEST FAILED. ALL HUNTERS REAWAKENED.`);
    broadcastGameState(room);
}

// --- BATTLE ENGINE ---
async function resolveConflict(room, p) {
    const coord = `${p.x}-${p.y}`;
    const opponent = room.players.find(o => o.id !== p.id && o.alive && o.x === p.x && o.y === p.y);
    
    if (opponent) {
        io.to(room.id).emit('battleStart', { hunter: p.name, hunterMana: p.mana, hunterColor: p.color, hunterPowerUp: p.powerUp, target: opponent.name, targetId: opponent.id, targetMana: opponent.mana, targetRank: `MP: ${opponent.mana}`, targetColor: opponent.color });
        await new Promise(r => setTimeout(r, 6000));
        let pCalc = p.mana, oCalc = opponent.mana, cancelled = false;
        
        [p, opponent].forEach(pl => {
            if (pl.activePowerUp) {
                if (pl.activePowerUp.type === 'DOUBLE DAMAGE') { if (pl.id === p.id) pCalc *= 2; else oCalc *= 2; }
                else if (pl.activePowerUp.type === 'GHOST WALK') { cancelled = true; pl.x = Math.floor(Math.random()*15); pl.y = Math.floor(Math.random()*15); io.to(room.id).emit('announcement', `${pl.name} GHOST WALKED!`); }
                pl.activePowerUp = null;
            }
        });

        if (!cancelled) {
            if (pCalc >= oCalc) { p.mana += opponent.mana; opponent.alive = false; if (!opponent.isAI && room.isOnline) recordLoss(opponent.name, p.mana); }
            else { opponent.mana += p.mana; p.alive = false; if (!p.isAI && room.isOnline) recordLoss(p.name, opponent.mana); }
        }
        io.to(room.id).emit('battleEnd');
        return;
    }

    if (room.world[coord]) {
        const gate = room.world[coord];
        io.to(room.id).emit('battleStart', { hunter: p.name, hunterMana: p.mana, hunterColor: p.color, hunterPowerUp: p.powerUp, target: `RANK ${gate.rank}`, targetMana: gate.mana, targetRank: `MP: ${gate.mana}`, targetColor: gate.color });
        await new Promise(r => setTimeout(r, 6000));
        if (p.mana >= gate.mana) {
            p.mana += gate.mana; delete room.world[coord];
            if (gate.rank === 'Silver') return processWin(room, p.name);
            if (Math.random() < 0.25 && !p.powerUp) { p.powerUp = POWER_UPS[Math.floor(Math.random()*POWER_UPS.length)]; io.to(p.id).emit('announcement', `SYSTEM: POWER-UP OBTAINED: ${p.powerUp}`); }
        } else {
            if (room.players.filter(pl => pl.alive).length === 1) triggerRespawn(room, p.id);
            else { p.alive = false; if (!p.isAI && room.isOnline) recordLoss(p.name, gate.mana); }
        }
        io.to(room.id).emit('battleEnd');
    }
}

function advanceTurn(room) {
    if (!rooms[room.id]) return;
    const alive = room.players.filter(pl => pl.alive);
    if (alive.length === 1 && room.survivorTurns >= 5) return triggerRespawn(room, room.players[room.turn].id);
    
    room.globalTurns++;
    if (alive.length === 1) room.survivorTurns++;
    if (room.globalTurns % (room.players.length * 3) === 0) for(let i=0; i<5; i++) spawnGate(room);
    
    let attempts = 0;
    do { room.turn = (room.turn + 1) % room.players.length; attempts++; } while (!room.players[room.turn].alive && attempts < 10);
    
    // Silver Gate Logic
    if (alive.length === 1 && !Object.values(room.world).some(g => g.rank === 'Silver')) {
        const survivor = room.players.find(pl => pl.alive);
        let sx = Math.max(0, Math.min(14, survivor.x + (Math.random() > 0.5 ? 4 : -4)));
        let sy = Math.max(0, Math.min(14, survivor.y + (Math.random() > 0.5 ? 4 : -4)));
        room.world[`${sx}-${sy}`] = { rank: 'Silver', color: '#fff', mana: Math.floor(Math.random() * 15000) + 2000 };
        io.to(room.id).emit('announcement', "SYSTEM: SILVER GATE APPEARED.");
    }

    const nextP = room.players[room.turn];
    if (nextP.isAI && nextP.alive) {
        setTimeout(async () => {
            if (!rooms[room.id]) return;
            let tx = nextP.x, ty = nextP.y;
            // MONARCH AI: Beeline for weakest targets or high value gates
            if (room.mode === 'Monarch') {
                let targets = [];
                Object.keys(room.world).forEach(c => { targets.push({x: parseInt(c.split('-')[0]), y: parseInt(c.split('-')[1]), val: room.world[c].mana}); });
                room.players.forEach(pl => { if(pl.alive && pl.id !== nextP.id) targets.push({x: pl.x, y: pl.y, val: pl.mana}); });
                targets.sort((a,b) => (Math.abs(nextP.x-a.x)+Math.abs(nextP.y-a.y)) - (Math.abs(nextP.x-b.x)+Math.abs(nextP.y-b.y)));
                if(targets[0]) {
                    if (targets[0].x > nextP.x) tx++; else if (targets[0].x < nextP.x) tx--;
                    if (targets[0].y > nextP.y) ty++; else if (targets[0].y < nextP.y) ty--;
                }
            } else { tx += (Math.random()>0.5?1:-1); ty += (Math.random()>0.5?1:-1); }
            tx = Math.max(0, Math.min(14, tx)); ty = Math.max(0, Math.min(14, ty));
            if (!isPathBlocked(room, nextP.x, nextP.y, tx, ty)) { nextP.x = tx; nextP.y = ty; await resolveConflict(room, nextP); }
            advanceTurn(room);
        }, 1000);
    }
    broadcastGameState(room);
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    socket.on('adminAction', async (data) => {
        if (socket.id !== adminSocketId) return;
        if (data.action === 'kick') {
            const targetSocketId = connectedUsers[data.target];
            const room = Object.values(rooms).find(r => r.players.some(p => p.name === data.target));
            if (room) {
                const p = room.players.find(pl => pl.name === data.target);
                p.quit = true; p.alive = false;
                await recordLoss(data.target, 500); 
                io.to(room.id).emit('announcement', `SYSTEM: ${data.target} KICKED BY ADMIN.`);
                const active = room.players.filter(pl => !pl.quit && !pl.isAI);
                if (active.length === 1 && room.active) await processWin(room, active[0].name);
                else broadcastGameState(room);
            }
            if (targetSocketId) {
                io.to(targetSocketId).emit('authError', "FORCED LOGOUT BY ADMIN.");
                setTimeout(() => io.sockets.sockets.get(targetSocketId)?.disconnect(), 500);
            }
        }
        if (data.action === 'broadcast') {
            const msg = { sender: 'SYSTEM ADMIN', text: data.message, rank: 'ADMIN', timestamp: new Date().toLocaleTimeString(), isAdmin: true };
            recentAdminMessages.push(msg);
            if(recentAdminMessages.length > 5) recentAdminMessages.shift();
            io.emit('receiveMessage', msg);
        }
        if (data.action === 'spectate') {
            const room = Object.values(rooms).find(r => r.players.some(p => p.name === data.targetName));
            if (room) { socket.join(room.id); socket.emit('gameStart', { roomId: room.id }); broadcastGameState(room); }
        }
    });

    socket.on('authRequest', async (data) => {
        const { data: user } = await supabase.from('Hunters').select('*').eq('username', data.u).eq('password', data.p).maybeSingle();
        if (user) {
            connectedUsers[user.username] = socket.id;
            if (user.username === ADMIN_NAME) adminSocketId = socket.id;
            sendProfileUpdate(socket, user.username);
            syncAllGates();
            broadcastWorldRankings();
        } else socket.emit('authError', "INVALID ACCESS.");
    });

    socket.on('joinChatRoom', (roomId) => {
        socket.rooms.forEach(r => { if(r !== socket.id) socket.leave(r); });
        socket.join(roomId);
        socket.emit('joinedRoom', roomId);
        recentAdminMessages.forEach(m => socket.emit('receiveMessage', m));
    });

    socket.on('sendMessage', async (data) => {
        const { data: u } = await supabase.from('Hunters').select('hunterpoints').eq('username', data.senderName).maybeSingle();
        const msg = { sender: data.senderName, text: data.message, rank: getDisplayRank(u?.hunterpoints || 0), timestamp: new Date().toLocaleTimeString(), isAdmin: data.senderName === ADMIN_NAME };
        io.to(data.roomId || 'global').emit('receiveMessage', msg);
    });

    socket.on('createGate', async (data) => {
        const id = `gate_${Date.now()}`;
        const wr = await getWorldRankDisplay(data.host);
        rooms[id] = { id, name: data.name, isOnline: true, active: false, turn: 0, globalTurns: 0, survivorTurns: 0, players: [{ id: socket.id, name: data.host, x: 0, y: 0, mana: 150, rankLabel: "Lower E-Rank", worldsRankLabel: wr.label, worldsRankColor: wr.color, alive: true, confirmed: false, color: PLAYER_COLORS[0], isAI: false, quit: false, powerUp: null, isAdmin: data.host === ADMIN_NAME }], world: {} };
        socket.join(id);
        io.to(id).emit('waitingRoomUpdate', rooms[id]);
        syncAllGates();
    });

    socket.on('joinGate', async (data) => {
        const room = rooms[data.gateID];
        if (room && room.players.length < 4) {
            const wr = await getWorldRankDisplay(data.user);
            const idx = room.players.length;
            const pos = corners[idx];
            room.players.push({ id: socket.id, name: data.user, x: pos.x, y: pos.y, mana: 150, rankLabel: "Lower E-Rank", worldsRankLabel: wr.label, worldsRankColor: wr.color, alive: true, confirmed: false, color: PLAYER_COLORS[idx], isAI: false, quit: false, powerUp: null, isAdmin: data.user === ADMIN_NAME });
            socket.join(data.gateID);
            io.to(data.gateID).emit('waitingRoomUpdate', room);
            syncAllGates();
        }
    });

    socket.on('playerConfirm', (data) => {
        const room = rooms[data.gateID];
        if (room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if(p) p.confirmed = true;
            if (room.players.length >= 2 && room.players.every(pl => pl.confirmed)) {
                room.active = true; for(let i=0; i<5; i++) spawnGate(room);
                io.to(room.id).emit('gameStart', { roomId: room.id });
                broadcastGameState(room);
                syncAllGates();
            } else io.to(room.id).emit('waitingRoomUpdate', room);
        }
    });

    socket.on('startSoloAI', async (data) => {
        const id = `solo_${socket.id}_${Date.now()}`;
        rooms[id] = {
            id, active: true, turn: 0, mode: data.diff, globalTurns: 0, survivorTurns: 0, isOnline: false,
            players: [
                { id: socket.id, name: data.user, x: 0, y: 0, mana: 150, alive: true, isAI: false, color: PLAYER_COLORS[0], powerUp: null, isAdmin: data.user === ADMIN_NAME },
                { id: 'ai1', name: AI_NAMES[1], x: 14, y: 0, mana: 200, alive: true, isAI: true, color: PLAYER_COLORS[1] },
                { id: 'ai2', name: AI_NAMES[2], x: 0, y: 14, mana: 200, alive: true, isAI: true, color: PLAYER_COLORS[2] },
                { id: 'ai3', name: AI_NAMES[3], x: 14, y: 14, mana: 200, alive: true, isAI: true, color: PLAYER_COLORS[3] }
            ], world: {}
        };
        for(let i=0; i<5; i++) spawnGate(rooms[id]);
        socket.join(id);
        socket.emit('gameStart', { roomId: id });
        broadcastGameState(rooms[id]);
    });

    socket.on('playerAction', async (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (!room || !room.active) return;
        const p = room.players[room.turn];
        if (!p || p.id !== socket.id) return;
        if (!isPathBlocked(room, p.x, p.y, data.tx, data.ty)) { p.x = data.tx; p.y = data.ty; await resolveConflict(room, p); advanceTurn(room); }
    });

    socket.on('activateSkill', (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        const p = room?.players.find(pl => pl.id === socket.id);
        if (p) { p.activePowerUp = { type: data.powerUp }; p.powerUp = null; io.to(room.id).emit('announcement', `${p.name} ACTIVATED ${data.powerUp}!`); }
    });

    socket.on('disconnect', () => {
        const name = Object.keys(connectedUsers).find(k => connectedUsers[k] === socket.id);
        if(name) delete connectedUsers[name];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: Server active on ${PORT}`));
