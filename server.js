const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- GAME DATA ---
const rooms = {};
const users = {}; // Simulated database for logins

// --- UPDATED RANKING HELPERS ---

function getDetailedRank(mana) {
    if (mana >= 1000) return "HIGHER S";
    if (mana >= 901) return "LOWER S";
    if (mana >= 801) return "HIGHER A";
    if (mana >= 701) return "LOWER A";
    if (mana >= 601) return "HIGHER B";
    if (mana >= 501) return "LOWER B";
    if (mana >= 401) return "HIGHER C";
    if (mana >= 301) return "LOWER C";
    if (mana >= 201) return "HIGHER D";
    if (mana >= 101) return "LOWER D";
    if (mana >= 51) return "HIGHER E";
    return "LOWER E";
}

function getShortRankLabel(mana) {
    if (mana >= 901) return "S-Rank";
    if (mana >= 701) return "A-Rank";
    if (mana >= 501) return "B-Rank";
    if (mana >= 301) return "C-Rank";
    if (mana >= 101) return "D-Rank";
    return "E-Rank";
}

// --- CORE LOGIC ---

function triggerRespawn(room, lastPlayerId) {
    const candidates = room.players.filter(p => !p.quit);
    if (candidates.length === 0) { delete rooms[room.id]; return; }
    
    room.respawnHappened = true; 

    candidates.forEach(pl => { 
        if (pl.id !== lastPlayerId) {
            const resurrectionBonus = Math.floor(Math.random() * 1001) + 500;
            pl.mana += resurrectionBonus; 
        }
        pl.alive = true;
        pl.rankLabel = getShortRankLabel(pl.mana);
    });
    
    room.world = {}; 
    room.globalTurns = 0;
    room.survivorTurns = 0; 
    const lastPlayerIdx = room.players.findIndex(pl => pl.id === lastPlayerId);
    room.turn = lastPlayerIdx;

    // Standard gate spawns on reset
    for(let i=0; i<5; i++) spawnGate(room); 
    io.to(room.id).emit('announcement', `SYSTEM: QUEST FAILED. ALL HUNTERS REAWAKENED.`);
    broadcastGameState(room);
}

function spawnGate(room) {
    const x = Math.floor(Math.random() * 15);
    const y = Math.floor(Math.random() * 15);
    const power = Math.floor(Math.random() * 300) + 50;
    room.world[`${x}-${y}`] = { type: 'mana', color: '#00ff00', power: power };
}

// SILVER GATE LOGIC: Spawns when only 1 player remains
function spawnSilverGate(room) {
    const x = Math.floor(Math.random() * 15);
    const y = Math.floor(Math.random() * 15);
    const power = Math.floor(Math.random() * 1001) + 500; // Power from 500 to 1500+
    room.world[`${x}-${y}`] = { 
        type: 'silver', 
        color: '#c0c0c0', 
        power: power,
        rank: 'Silver'
    };
    io.to(room.id).emit('announcement', `WARNING: SILVER GATE MANIFESTED. POWER: ${power}`);
}

function broadcastGameState(room) { 
    // Logic to check if only one player is alive to spawn Silver Gate
    const alivePlayers = room.players.filter(p => p.alive && !p.quit);
    const silverExists = Object.values(room.world).some(cell => cell.type === 'silver');

    if (alivePlayers.length === 1 && !silverExists) {
        spawnSilverGate(room);
    }

    const sanitizedPlayers = room.players.map(p => {
        const shortRank = getShortRankLabel(p.mana);
        return {
            ...p,
            rankLabel: shortRank,
            displayName: `${p.name} (${shortRank})` 
        };
    });
    
    const state = { ...room, players: sanitizedPlayers };
    io.to(room.id).emit('gameStateUpdate', state); 
}

// --- SOCKET CONNECTION & CHAT SYSTEM ---

io.on('connection', (socket) => {
    
    // 1. MULTIPLAYER CHAT HANDLER
    socket.on('sendMessage', (data) => {
        const { roomId, message, senderName } = data;
        const userMana = users[senderName]?.mana || 0;
        const rank = getDetailedRank(userMana);

        if (!roomId) {
            io.emit('receiveGlobalMessage', { sender: senderName, text: message });
        } else {
            io.to(roomId).emit('receiveMessage', { 
                sender: senderName, 
                text: message, 
                rank: rank 
            });
        }
    });

    // 2. AUTHENTICATION (Fixed Priority #1)
    socket.on('authRequest', (data) => {
        const { type, u, p } = data;
        
        if (type === 'signup') {
            if (!users[u]) {
                users[u] = { username: u, password: p, mana: 20, wins: 0, losses: 0 };
            } else {
                return socket.emit('authError', "HUNTER ID ALREADY EXISTS");
            }
        }
        
        const user = users[u];
        if (user && user.password === p) {
            socket.emit('authSuccess', {
                username: user.username,
                mana: user.mana,
                rank: getDetailedRank(user.mana),
                color: '#00d2ff',
                wins: user.wins,
                losses: user.losses
            });
        } else {
            socket.emit('authError', "INVALID ACCESS CODE");
        }
    });

    // 3. WORLD RANKINGS (Required for UI transition)
    socket.on('requestWorldRankings', () => {
        const rankings = Object.values(users)
            .sort((a, b) => b.mana - a.mana)
            .slice(0, 10)
            .map(u => ({ username: u.username, manapoints: u.mana }));
        socket.emit('updateWorldRankings', rankings);
    });

    // 4. GATE/ROOM JOINING
    socket.on('joinGate', (data) => {
        const { gateID, user } = data;
        socket.join(gateID);
        // Room initialization logic would trigger broadcastGameState here
    });

    socket.on('disconnect', () => {
        console.log('Hunter disconnected');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`System Online on Port ${PORT}`);
});
