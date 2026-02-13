const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

const PORT = 3000;
const DATA_FILE = './players.json';

// --- DATABASE LOGIC ---
let playerDB = {};
if (fs.existsSync(DATA_FILE)) {
    playerDB = JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveDB() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(playerDB, null, 2));
}

// --- RANKING HELPERS ---
function getManaRank(mana) {
    if (mana >= 1000) return "Higher S-Rank";
    if (mana >= 901) return "Lower S-Rank";
    if (mana >= 801) return "Higher A-Rank";
    if (mana >= 701) return "Lower A-Rank";
    if (mana >= 601) return "Higher B-Rank";
    if (mana >= 501) return "Lower B-Rank";
    if (mana >= 401) return "Higher C-Rank";
    if (mana >= 301) return "Lower C-Rank";
    if (mana >= 201) return "Higher D-Rank";
    if (mana >= 101) return "Lower D-Rank";
    if (mana >= 51) return "Higher E-Rank";
    return "Lower E-Rank";
}

function getShortRankLabel(mana) {
    if (mana >= 901) return "S-Rank";
    if (mana >= 701) return "A-Rank";
    if (mana >= 501) return "B-Rank";
    if (mana >= 301) return "C-Rank";
    if (mana >= 101) return "D-Rank";
    return "E-Rank";
}

// --- GAME STATE ---
let rooms = {};

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log(`Hunter Connected: ${socket.id}`);

    // --- AUTHENTICATION ---
    socket.on('authRequest', (data) => {
        const { type, u, p } = data;
        if (type === 'signup') {
            if (playerDB[u]) return socket.emit('authError', "ID ALREADY EXISTS");
            playerDB[u] = { username: u, pass: p, mana: 0, wins: 0, losses: 0, color: '#00d2ff' };
        }
        if (!playerDB[u] || playerDB[u].pass !== p) return socket.emit('authError', "INVALID CREDENTIALS");

        saveDB();
        const hunter = playerDB[u];
        socket.emit('authSuccess', {
            username: u,
            mana: hunter.mana,
            rank: getManaRank(hunter.mana),
            wins: hunter.wins,
            losses: hunter.losses,
            color: hunter.color
        });
        sendWorldRankings();
    });

    socket.on('requestWorldRankings', sendWorldRankings);

    // --- CHAT LOGIC ---
    socket.on('sendChatMessage', (data) => {
        // Broadcast to the specific room (lobby or gate ID)
        io.to(data.room).emit('receiveChatMessage', {
            user: data.user,
            msg: data.msg
        });
    });

    // --- MULTIPLAYER LOBBY ---
    socket.on('requestGateList', () => {
        socket.join('lobby');
        updateGateList();
    });

    socket.on('createGate', (data) => {
        const roomID = `GATE_${Math.random().toString(36).substr(2, 5)}`;
        rooms[roomID] = {
            id: roomID,
            name: data.name,
            players: [],
            world: {},
            turn: 0,
            globalTurns: 0,
            active: false,
            respawnHappened: false
        };
        socket.emit('gateCreated', roomID);
        updateGateList();
    });

    socket.on('joinGate', (data) => {
        const room = rooms[data.gateID];
        if (!room || room.players.length >= 4 || room.active) return;
        
        socket.leave('lobby');
        socket.join(data.gateID);
        
        const hunter = playerDB[data.user];
        room.players.push({
            id: socket.id,
            name: hunter.username,
            mana: hunter.mana,
            x: 0, y: 0,
            alive: true,
            confirmed: false,
            color: `hsl(${Math.random() * 360}, 70%, 60%)`
        });
        io.to(room.id).emit('waitingRoomUpdate', room);
    });

    socket.on('playerConfirm', (data) => {
        const room = rooms[data.gateID];
        if (!room) return;
        const p = room.players.find(pl => pl.id === socket.id);
        if (p) p.confirmed = true;

        if (room.players.length >= 2 && room.players.every(pl => pl.confirmed)) {
            startGame(room);
        } else {
            io.to(room.id).emit('waitingRoomUpdate', room);
        }
    });

    // --- GAME CORE ---
    function startGame(room) {
        room.active = true;
        room.players.forEach((p, i) => {
            p.x = i % 2 === 0 ? 0 : 14;
            p.y = i < 2 ? 0 : 14;
        });
        for (let i = 0; i < 8; i++) spawnGate(room);
        io.to(room.id).emit('gameStart');
        broadcastGameState(room);
    }

    socket.on('playerAction', (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (!room || !room.active) return;

        const p = room.players[room.turn];
        if (p.id !== socket.id) return;

        // Move Player
        p.x = data.tx;
        p.y = data.ty;

        // Check Cell Collision
        const cellKey = `${p.x}-${p.y}`;
        const target = room.world[cellKey];

        if (target) {
            handleCollision(room, p, target, cellKey);
        } else {
            nextTurn(room);
        }
    });

    function handleCollision(room, hunter, target, key) {
        if (target.type === 'gate') {
            if (hunter.mana >= target.mana) {
                hunter.mana += Math.floor(target.mana * 0.2);
                delete room.world[key];
                io.to(room.id).emit('announcement', `${hunter.name} cleared a ${target.rank} gate!`);
            } else {
                hunter.alive = false;
                io.to(room.id).emit('announcement', `${hunter.name} was consumed by a ${target.rank} gate!`);
            }
        }
        nextTurn(room);
    }

    function nextTurn(room) {
        room.globalTurns++;
        
        // Spawn Random Gate every 3 cycles
        if (room.globalTurns % (room.players.length * 3) === 0) {
            spawnGate(room);
        }

        // Check Survivors
        const alivePlayers = room.players.filter(p => p.alive && !p.quit);
        
        if (alivePlayers.length === 1) {
            const survivor = alivePlayers[0];
            // Check for Silver Gate
            const silverExists = Object.values(room.world).some(g => g.rank === 'Silver');
            if (!silverExists) {
                spawnSilverGate(room);
            }
        }

        if (alivePlayers.length === 0) {
            triggerRespawn(room, socket.id);
            return;
        }

        // Standard Turn Increment
        do {
            room.turn = (room.turn + 1) % room.players.length;
        } while (!room.players[room.turn].alive || room.players[room.turn].quit);

        broadcastGameState(room);
    }

    function spawnGate(room) {
        const x = Math.floor(Math.random() * 15);
        const y = Math.floor(Math.random() * 15);
        if (room.world[`${x}-${y}`]) return;

        const ranks = [
            { r: 'E', m: 20, c: '#00ff00' },
            { r: 'D', m: 150, c: '#99ff00' },
            { r: 'C', m: 350, c: '#ffff00' },
            { r: 'B', m: 550, c: '#ff9900' },
            { r: 'A', m: 750, c: '#ff00ff' }
        ];
        
        // Add Red Gates if respawn happened
        if (room.respawnHappened) ranks.push({ r: 'S', m: 950, c: '#ff0000' });

        const res = ranks[Math.floor(Math.random() * ranks.length)];
        room.world[`${x}-${y}`] = { type: 'gate', rank: res.r, mana: res.m, color: res.c };
    }

    function spawnSilverGate(room) {
        const x = Math.floor(Math.random() * 15);
        const y = Math.floor(Math.random() * 15);
        const power = Math.floor(Math.random() * 501) + 500; // 500 to 1000
        room.world[`${x}-${y}`] = { type: 'gate', rank: 'Silver', mana: power, color: '#c0c0c0' };
        io.to(room.id).emit('announcement', `A SILVER GATE HAS APPEARED! DEFEAT IT TO WIN.`);
    }

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
        const lastPlayerIdx = room.players.findIndex(pl => pl.id === lastPlayerId);
        room.turn = lastPlayerIdx;

        for(let i=0; i<5; i++) spawnGate(room);
        io.to(room.id).emit('announcement', `SYSTEM: QUEST FAILED. ALL HUNTERS REAWAKENED.`);
        broadcastGameState(room);
    }

    function broadcastGameState(room) { 
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

    function updateGateList() {
        const list = Object.values(rooms).filter(r => !r.active).map(r => ({
            id: r.id, name: r.name, count: r.players.length
        }));
        io.to('lobby').emit('updateGateList', list);
    }

    function sendWorldRankings() {
        const list = Object.values(playerDB)
            .sort((a, b) => b.mana - a.mana)
            .slice(0, 10)
            .map(p => ({ username: p.username, manapoints: p.mana }));
        io.emit('updateWorldRankings', list);
    }

    socket.on('disconnect', () => {
        // Handle cleaning up rooms on disconnect
    });
});

http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
