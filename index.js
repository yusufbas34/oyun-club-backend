try {
  require('dotenv').config();
} catch (e) {}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

// ============================================================
// IN-MEMORY STATE (Redis yerine - production'da Redis kullan)
// ============================================================
const rooms = new Map(); // roomId -> Room
const users = new Map(); // socketId -> User
const stats = new Map(); // oderId -> { games: {}, history: [] }

// ============================================================
// DATA MODELS
// ============================================================
/*
  Room {
    id: string,
    gameId: string,         // "xox" | "minesweeper" | "rps" | "memory" | "snake"
    hostId: string,         // socket id of host
    players: [{ id, name, socketId }],
    state: "waiting" | "playing" | "finished",
    gameState: {},          // game-specific state
    chat: [{ userId, name, message, timestamp }],
    createdAt: Date,
    maxPlayers: number,
  }

  User {
    id: string,
    name: string,
    socketId: string,
    roomId: string | null,
  }
*/

const GAME_CONFIG = {
  xox: { maxPlayers: 2 },
  minesweeper: { maxPlayers: 1 },
  rps: { maxPlayers: 2 },
  memory: { maxPlayers: 1 },
  snake: { maxPlayers: 1 },
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function createRoom(gameId, host) {
  const roomId = generateRoomCode();
  const config = GAME_CONFIG[gameId] || { maxPlayers: 2 };
  const room = {
    id: roomId,
    gameId,
    hostId: host.socketId,
    players: [{ id: host.id, name: host.name, socketId: host.socketId }],
    state: 'waiting',
    gameState: null,
    chat: [],
    createdAt: new Date(),
    maxPlayers: config.maxPlayers,
  };
  rooms.set(roomId, room);
  return room;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Ambiguous chars removed
  let code = '';
  for (let i = 0; i < 6; i++)
    code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function getRoomSafe(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    id: room.id,
    gameId: room.gameId,
    players: room.players.map((p) => ({ id: p.id, name: p.name })),
    state: room.state,
    gameState: room.gameState,
    chat: room.chat.slice(-50), // Last 50 messages
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
  };
}

function initGameState(gameId, players) {
  switch (gameId) {
    case 'xox':
      return {
        board: Array(9).fill(null),
        currentTurn: 0, // index in players array
        winner: null,
        winLine: null,
      };
    case 'rps':
      return {
        round: 1,
        scores: [0, 0],
        choices: [null, null],
        roundResult: null,
        gameWinner: null,
      };
    default:
      return {};
  }
}

// ============================================================
// XOX GAME LOGIC
// ============================================================
function processXOXMove(room, playerIndex, cellIndex) {
  const gs = room.gameState;
  if (gs.winner !== null) return { error: 'Oyun bitti' };
  if (gs.currentTurn !== playerIndex) return { error: 'Sıra sende değil' };
  if (gs.board[cellIndex] !== null) return { error: 'Bu hücre dolu' };

  gs.board[cellIndex] = playerIndex === 0 ? 'X' : 'O';

  // Check winner
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    if (
      gs.board[a] &&
      gs.board[a] === gs.board[b] &&
      gs.board[a] === gs.board[c]
    ) {
      gs.winner = gs.board[a] === 'X' ? 0 : 1;
      gs.winLine = [a, b, c];
      room.state = 'finished';
      return { success: true, finished: true };
    }
  }

  // Check draw
  if (gs.board.every((c) => c !== null)) {
    gs.winner = 'draw';
    room.state = 'finished';
    return { success: true, finished: true };
  }

  gs.currentTurn = gs.currentTurn === 0 ? 1 : 0;
  return { success: true, finished: false };
}

// ============================================================
// RPS GAME LOGIC
// ============================================================
function processRPSChoice(room, playerIndex, choice) {
  const gs = room.gameState;
  if (gs.gameWinner !== null) return { error: 'Oyun bitti' };
  if (gs.choices[playerIndex] !== null) return { error: 'Zaten seçim yaptın' };

  gs.choices[playerIndex] = choice;

  // Both players chose?
  if (gs.choices[0] !== null && gs.choices[1] !== null) {
    const [c0, c1] = gs.choices;
    const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

    let roundResult;
    if (c0 === c1) roundResult = 'draw';
    else if (beats[c0] === c1) roundResult = 0;
    else roundResult = 1;

    gs.roundResult = roundResult;
    if (typeof roundResult === 'number') gs.scores[roundResult]++;

    // Check game winner (best of 5 -> first to 3)
    if (gs.scores[0] >= 3) {
      gs.gameWinner = 0;
      room.state = 'finished';
    } else if (gs.scores[1] >= 3) {
      gs.gameWinner = 1;
      room.state = 'finished';
    }

    return { success: true, reveal: true, finished: gs.gameWinner !== null };
  }

  return { success: true, reveal: false, waiting: true };
}

function resetRPSRound(room) {
  const gs = room.gameState;
  gs.choices = [null, null];
  gs.roundResult = null;
  gs.round++;
}

// ============================================================
// SOCKET.IO EVENT HANDLERS
// ============================================================
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // --- AUTH / REGISTER ---
  socket.on('register', ({ name }, callback) => {
    const user = {
      id: uuidv4(),
      name: name || 'Anonim',
      socketId: socket.id,
      roomId: null,
    };
    users.set(socket.id, user);
    console.log(`[*] Registered: ${user.name} (${user.id})`);
    callback({ success: true, user: { id: user.id, name: user.name } });
  });

  // --- ROOM: CREATE ---
  socket.on('create_room', ({ gameId }, callback) => {
    const user = users.get(socket.id);
    if (!user) return callback({ error: 'Kayıtlı değilsin' });

    const room = createRoom(gameId, user);
    user.roomId = room.id;
    socket.join(room.id);

    console.log(`[+] Room created: ${room.id} (${gameId}) by ${user.name}`);
    callback({ success: true, room: getRoomSafe(room.id) });
  });

  // --- ROOM: JOIN ---
  socket.on('join_room', ({ roomId }, callback) => {
    const user = users.get(socket.id);
    if (!user) return callback({ error: 'Kayıtlı değilsin' });

    const code = roomId.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return callback({ error: 'Masa bulunamadı' });
    if (room.state !== 'waiting')
      return callback({ error: 'Oyun zaten başlamış' });
    if (room.players.length >= room.maxPlayers)
      return callback({ error: 'Masa dolu' });
    if (room.players.some((p) => p.socketId === socket.id))
      return callback({ error: 'Zaten bu masadasın' });

    room.players.push({ id: user.id, name: user.name, socketId: socket.id });
    user.roomId = room.id;
    socket.join(room.id);

    console.log(`[+] ${user.name} joined room ${room.id}`);
    io.to(room.id).emit('room_updated', getRoomSafe(room.id));
    callback({ success: true, room: getRoomSafe(room.id) });
  });

  // --- ROOM: LEAVE ---
  socket.on('leave_room', (_, callback) => {
    handleLeaveRoom(socket);
    if (callback) callback({ success: true });
  });

  // --- GAME: START ---
  socket.on('start_game', (_, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback({ error: 'Masada değilsin' });

    const room = rooms.get(user.roomId);
    if (!room) return callback({ error: 'Masa bulunamadı' });
    if (room.hostId !== socket.id)
      return callback({ error: 'Sadece host başlatabilir' });
    if (room.state !== 'waiting')
      return callback({ error: 'Oyun zaten başlamış' });

    // Multiplayer games need enough players
    const config = GAME_CONFIG[room.gameId];
    if (config.maxPlayers > 1 && room.players.length < config.maxPlayers) {
      return callback({ error: 'Yeterli oyuncu yok' });
    }

    room.state = 'playing';
    room.gameState = initGameState(room.gameId, room.players);

    console.log(`[▶] Game started in room ${room.id}`);
    io.to(room.id).emit('game_started', getRoomSafe(room.id));
    callback({ success: true });
  });

  // --- GAME: MOVE (XOX) ---
  socket.on('xox_move', ({ cellIndex }, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback({ error: 'Masada değilsin' });

    const room = rooms.get(user.roomId);
    if (!room || room.gameId !== 'xox' || room.state !== 'playing')
      return callback({ error: 'Geçersiz oyun durumu' });

    const playerIndex = room.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex === -1) return callback({ error: 'Bu masada değilsin' });

    const result = processXOXMove(room, playerIndex, cellIndex);
    if (result.error) return callback({ error: result.error });

    io.to(room.id).emit('game_state_updated', {
      gameState: room.gameState,
      state: room.state,
    });

    if (result.finished) {
      const winnerName =
        room.gameState.winner === 'draw'
          ? null
          : room.players[room.gameState.winner]?.name;
      io.to(room.id).emit('game_finished', {
        winner: room.gameState.winner,
        winnerName,
        winLine: room.gameState.winLine,
      });
    }

    callback({ success: true });
  });

  // --- GAME: RPS CHOICE ---
  socket.on('rps_choice', ({ choice }, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback({ error: 'Masada değilsin' });

    const room = rooms.get(user.roomId);
    if (!room || room.gameId !== 'rps' || room.state !== 'playing')
      return callback({ error: 'Geçersiz oyun durumu' });

    const playerIndex = room.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex === -1) return callback({ error: 'Bu masada değilsin' });

    const result = processRPSChoice(room, playerIndex, choice);
    if (result.error) return callback({ error: result.error });

    if (result.waiting) {
      // Notify opponent that this player chose (without revealing choice)
      socket.to(room.id).emit('rps_opponent_chose');
    }

    if (result.reveal) {
      io.to(room.id).emit('rps_reveal', {
        choices: room.gameState.choices,
        roundResult: room.gameState.roundResult,
        scores: room.gameState.scores,
        gameWinner: room.gameState.gameWinner,
      });

      // Auto-reset round after delay (if game not finished)
      if (!result.finished) {
        setTimeout(() => {
          resetRPSRound(room);
          io.to(room.id).emit('rps_new_round', {
            round: room.gameState.round,
            scores: room.gameState.scores,
          });
        }, 3000);
      }
    }

    callback({ success: true });
  });

  // --- GAME: RESTART ---
  socket.on('restart_game', (_, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback({ error: 'Masada değilsin' });

    const room = rooms.get(user.roomId);
    if (!room) return callback({ error: 'Masa bulunamadı' });

    room.state = 'playing';
    room.gameState = initGameState(room.gameId, room.players);

    io.to(room.id).emit('game_started', getRoomSafe(room.id));
    callback({ success: true });
  });

  // --- CHAT ---
  socket.on('chat_message', ({ message }, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback?.({ error: 'Masada değilsin' });

    const room = rooms.get(user.roomId);
    if (!room) return callback?.({ error: 'Masa bulunamadı' });

    const msg = {
      id: uuidv4(),
      userId: user.id,
      name: user.name,
      message: message.slice(0, 500), // Max 500 chars
      timestamp: Date.now(),
    };

    room.chat.push(msg);
    if (room.chat.length > 100) room.chat = room.chat.slice(-100); // Keep last 100

    io.to(room.id).emit('chat_new_message', msg);
    console.log(`[💬] ${user.name} in ${room.id}: ${msg.message}`);
    if (callback) callback({ success: true });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    handleLeaveRoom(socket);
    users.delete(socket.id);
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

function handleLeaveRoom(socket) {
  const user = users.get(socket.id);
  if (!user || !user.roomId) return;

  const room = rooms.get(user.roomId);
  if (!room) {
    user.roomId = null;
    return;
  }

  room.players = room.players.filter((p) => p.socketId !== socket.id);
  socket.leave(room.id);

  if (room.players.length === 0) {
    // Empty room - delete
    rooms.delete(room.id);
    console.log(`[x] Room deleted: ${room.id}`);
  } else {
    // Transfer host if needed
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].socketId;
    }
    io.to(room.id).emit('room_updated', getRoomSafe(room.id));
    io.to(room.id).emit('player_left', { name: user.name });
  }

  user.roomId = null;
}

// ============================================================
// REST API ENDPOINTS
// ============================================================
app.get('/', (req, res) => {
  res.json({
    name: 'oyun.club API',
    version: '1.0.0',
    status: 'running',
    rooms: rooms.size,
    users: users.size,
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/rooms', (req, res) => {
  const publicRooms = [];
  rooms.forEach((room) => {
    if (room.state === 'waiting') {
      publicRooms.push({
        id: room.id,
        gameId: room.gameId,
        players: room.players.length,
        maxPlayers: room.maxPlayers,
        hostName: room.players[0]?.name,
      });
    }
  });
  res.json({ rooms: publicRooms });
});

app.get('/api/stats', (req, res) => {
  res.json({
    totalRooms: rooms.size,
    totalUsers: users.size,
    activeGames: [...rooms.values()].filter((r) => r.state === 'playing')
      .length,
  });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     oyun.club Backend Server         ║
  ║     Port: ${PORT}                       ║
  ║     Status: Running ✅               ║
  ╚══════════════════════════════════════╝
  `);
});
