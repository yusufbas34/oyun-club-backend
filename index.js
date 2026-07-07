try { require('dotenv').config(); } catch (e) {}
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// ============================================================
// MONGODB BAĞLANTISI
// ============================================================
const MONGODB_URI = process.env.MONGODB_URI;
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('[DB] MongoDB bağlandı ✅'))
    .catch(err => console.error('[DB] MongoDB hatası:', err));
} else {
  console.warn('[DB] MONGODB_URI yok — arkadaş sistemi geçici modda');
}

const userSchema = new mongoose.Schema({
  userId:   { type: String, required: true, unique: true },
  name:     { type: String, required: true },
  friends:  [String],
  pendingRequests: [{ fromId: String, fromName: String }],
}, { timestamps: true });
const DBUser = mongoose.model('User', userSchema);

const dbReady = () => mongoose.connection.readyState === 1;

// ============================================================
// IN-MEMORY STATE
// ============================================================
const rooms = new Map();
const users = new Map(); // socketId -> User
const onlineSockets = new Map(); // userId -> socketId

const GAME_CONFIG = {
  xox: { maxPlayers: 2 }, minesweeper: { maxPlayers: 1 },
  rps: { maxPlayers: 2 }, memory: { maxPlayers: 1 },
  snake: { maxPlayers: 1 }, connectfour: { maxPlayers: 2 },
  gomoku: { maxPlayers: 2 }, reaction: { maxPlayers: 2 },
  mathduel: { maxPlayers: 2 }, cardbattle: { maxPlayers: 2 },
  memorybattle: { maxPlayers: 2 }, wordrace: { maxPlayers: 2 },
};

// ============================================================
// HELPERS
// ============================================================
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function createRoom(gameId, host, isPublic) {
  const roomId = generateRoomCode();
  const config = GAME_CONFIG[gameId] || { maxPlayers: 2 };
  const room = {
    id: roomId, gameId,
    hostId: host.socketId,
    players: [{ id: host.id, name: host.name, socketId: host.socketId }],
    state: 'waiting', gameState: null, chat: [],
    createdAt: new Date(), maxPlayers: config.maxPlayers,
    isPublic: isPublic !== false,
  };
  rooms.set(roomId, room);
  return room;
}

function getRoomSafe(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    id: room.id, gameId: room.gameId,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    state: room.state, gameState: room.gameState,
    chat: room.chat.slice(-50), maxPlayers: room.maxPlayers,
    hostId: room.hostId, isPublic: room.isPublic,
  };
}

function initGameState(gameId) {
  switch (gameId) {
    case 'xox': return { board: Array(9).fill(null), currentTurn: 0, winner: null, winLine: null };
    case 'rps': return { round: 1, scores: [0, 0], choices: [null, null], roundResult: null, gameWinner: null };
    default: return {};
  }
}

function processXOXMove(room, playerIndex, cellIndex) {
  const gs = room.gameState;
  if (gs.winner !== null) return { error: 'Oyun bitti' };
  if (gs.currentTurn !== playerIndex) return { error: 'Sıra sende değil' };
  if (gs.board[cellIndex] !== null) return { error: 'Bu hücre dolu' };
  gs.board[cellIndex] = playerIndex === 0 ? 'X' : 'O';
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) {
    if (gs.board[a] && gs.board[a] === gs.board[b] && gs.board[a] === gs.board[c]) {
      gs.winner = gs.board[a] === 'X' ? 0 : 1;
      gs.winLine = [a,b,c];
      room.state = 'finished';
      return { success: true, finished: true };
    }
  }
  if (gs.board.every(c => c !== null)) { gs.winner = 'draw'; room.state = 'finished'; return { success: true, finished: true }; }
  gs.currentTurn = gs.currentTurn === 0 ? 1 : 0;
  return { success: true, finished: false };
}

function processRPSChoice(room, playerIndex, choice) {
  const gs = room.gameState;
  if (gs.gameWinner !== null) return { error: 'Oyun bitti' };
  if (gs.choices[playerIndex] !== null) return { error: 'Zaten seçim yaptın' };
  gs.choices[playerIndex] = choice;
  if (gs.choices[0] !== null && gs.choices[1] !== null) {
    const [c0, c1] = gs.choices;
    const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
    let roundResult = c0 === c1 ? 'draw' : beats[c0] === c1 ? 0 : 1;
    gs.roundResult = roundResult;
    if (typeof roundResult === 'number') gs.scores[roundResult]++;
    if (gs.scores[0] >= 3) { gs.gameWinner = 0; room.state = 'finished'; }
    else if (gs.scores[1] >= 3) { gs.gameWinner = 1; room.state = 'finished'; }
    return { success: true, reveal: true, finished: gs.gameWinner !== null };
  }
  return { success: true, reveal: false, waiting: true };
}

function resetRPSRound(room) {
  const gs = room.gameState;
  gs.choices = [null, null]; gs.roundResult = null; gs.round++;
}

function getPublicRoomsList() {
  const list = [];
  rooms.forEach(room => {
    if (room.state === 'waiting' && room.isPublic !== false) {
      list.push({
        id: room.id, gameId: room.gameId,
        gameName: room.gameId, players: room.players.length,
        maxPlayers: room.maxPlayers, hostName: room.players[0]?.name,
        createdAt: room.createdAt instanceof Date ? room.createdAt.getTime() : Date.now(),
      });
    }
  });
  return list.sort((a,b) => a.createdAt - b.createdAt).slice(0,15);
}

function broadcastPublicRooms() {
  io.emit('rooms_updated', { rooms: getPublicRoomsList() });
}

function handleLeaveRoom(socket) {
  const user = users.get(socket.id);
  if (!user || !user.roomId) return;
  const room = rooms.get(user.roomId);
  if (!room) { user.roomId = null; return; }
  room.players = room.players.filter(p => p.socketId !== socket.id);
  socket.leave(room.id);
  if (room.players.length === 0) {
    rooms.delete(room.id);
  } else {
    if (room.hostId === socket.id) room.hostId = room.players[0].socketId;
    io.to(room.id).emit('room_updated', getRoomSafe(room.id));
    io.to(room.id).emit('player_left', { name: user.name });
  }
  user.roomId = null;
  broadcastPublicRooms();
}

// ============================================================
// SOCKET.IO
// ============================================================
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());

io.on('connection', (socket) => {
  console.log(`[+] Bağlandı: ${socket.id}`);

  // --- KAYIT ---
  socket.on('register', ({ name, userId }, callback) => {
    const id = userId || uuidv4();
    const user = { id, name: name || 'Anonim', socketId: socket.id, roomId: null };
    users.set(socket.id, user);
    onlineSockets.set(id, socket.id);

    if (dbReady()) {
      DBUser.findOneAndUpdate(
        { userId: id },
        { $set: { userId: id, name: user.name } },
        { upsert: true, new: true }
      ).catch(err => console.error('[DB] register hatası:', err));
    }

    console.log(`[*] Kayıt: ${user.name} (${id})`);
    callback({ success: true, user: { id, name: user.name } });
  });

  // ============================================================
  // ARKADAŞ SİSTEMİ
  // ============================================================

  // Kullanıcı ara
  socket.on('search_user', async ({ query }, callback) => {
    if (!dbReady()) return callback({ error: 'DB bağlı değil' });
    try {
      const results = await DBUser.find(
        { name: { $regex: query, $options: 'i' } },
        { userId: 1, name: 1, _id: 0 }
      ).limit(10);
      const me = users.get(socket.id);
      callback({ success: true, users: results.filter(u => u.userId !== me?.id) });
    } catch (err) {
      callback({ error: 'Arama hatası' });
    }
  });

  // Arkadaşlık isteği gönder
  socket.on('friend_request', async ({ toId }, callback) => {
    const me = users.get(socket.id);
    if (!me) return callback({ error: 'Kayıtlı değilsin' });
    if (!dbReady()) return callback({ error: 'DB bağlı değil' });

    try {
      const target = await DBUser.findOne({ userId: toId });
      if (!target) return callback({ error: 'Kullanıcı bulunamadı' });

      const alreadyFriend = target.friends.includes(me.id);
      const alreadyPending = target.pendingRequests.some(r => r.fromId === me.id);
      if (alreadyFriend) return callback({ error: 'Zaten arkadaşsınız' });
      if (alreadyPending) return callback({ error: 'İstek zaten gönderildi' });

      await DBUser.findOneAndUpdate(
        { userId: toId },
        { $push: { pendingRequests: { fromId: me.id, fromName: me.name } } }
      );

      // Karşı taraf çevrimiçiyse bildir
      const targetSocketId = onlineSockets.get(toId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('friend_request_incoming', { fromId: me.id, fromName: me.name });
      }

      callback({ success: true });
    } catch (err) {
      callback({ error: 'İstek gönderilemedi' });
    }
  });

  // Arkadaşlık isteğini kabul et
  socket.on('accept_friend', async ({ fromId }, callback) => {
    const me = users.get(socket.id);
    if (!me) return callback({ error: 'Kayıtlı değilsin' });
    if (!dbReady()) return callback({ error: 'DB bağlı değil' });

    try {
      // İkisini de arkadaş olarak ekle, isteği temizle
      await DBUser.findOneAndUpdate(
        { userId: me.id },
        {
          $pull: { pendingRequests: { fromId } },
          $addToSet: { friends: fromId },
        }
      );
      await DBUser.findOneAndUpdate(
        { userId: fromId },
        { $addToSet: { friends: me.id } }
      );

      // Karşı tarafa bildir
      const fromSocketId = onlineSockets.get(fromId);
      if (fromSocketId) {
        io.to(fromSocketId).emit('friend_accepted', { byId: me.id, byName: me.name });
      }

      callback({ success: true });
    } catch (err) {
      callback({ error: 'Kabul hatası' });
    }
  });

  // Arkadaşlık isteğini reddet
  socket.on('reject_friend', async ({ fromId }, callback) => {
    const me = users.get(socket.id);
    if (!me) return callback({ error: 'Kayıtlı değilsin' });
    if (!dbReady()) return callback({ error: 'DB bağlı değil' });

    try {
      await DBUser.findOneAndUpdate(
        { userId: me.id },
        { $pull: { pendingRequests: { fromId } } }
      );
      callback({ success: true });
    } catch (err) {
      callback({ error: 'Red hatası' });
    }
  });

  // Arkadaş listesini getir
  socket.on('get_friends', async (_, callback) => {
    const me = users.get(socket.id);
    if (!me) return callback({ error: 'Kayıtlı değilsin' });
    if (!dbReady()) return callback({ friends: [], pending: [] });

    try {
      const dbUser = await DBUser.findOne({ userId: me.id });
      if (!dbUser) return callback({ friends: [], pending: [] });

      const friendDocs = await DBUser.find(
        { userId: { $in: dbUser.friends } },
        { userId: 1, name: 1, _id: 0 }
      );

      const friends = friendDocs.map(f => ({
        userId: f.userId,
        name: f.name,
        online: onlineSockets.has(f.userId),
      }));

      callback({
        success: true,
        friends,
        pending: dbUser.pendingRequests || [],
      });
    } catch (err) {
      callback({ error: 'Liste alınamadı' });
    }
  });

  // ============================================================
  // ODA İŞLEMLERİ
  // ============================================================
  socket.on('create_room', ({ gameId, isPublic }, callback) => {
    const user = users.get(socket.id);
    if (!user) return callback({ error: 'Kayıtlı değilsin' });
    const room = createRoom(gameId, user, isPublic);
    user.roomId = room.id;
    socket.join(room.id);
    if (isPublic !== false) broadcastPublicRooms();
    callback({ success: true, room: getRoomSafe(room.id) });
  });

  socket.on('join_room', ({ roomId }, callback) => {
    const user = users.get(socket.id);
    if (!user) return callback({ error: 'Kayıtlı değilsin' });
    const code = roomId.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return callback({ error: 'Masa bulunamadı' });
    if (room.state !== 'waiting') return callback({ error: 'Oyun zaten başlamış' });
    if (room.players.length >= room.maxPlayers) return callback({ error: 'Masa dolu' });
    if (room.players.some(p => p.socketId === socket.id)) return callback({ error: 'Zaten bu masadasın' });
    room.players.push({ id: user.id, name: user.name, socketId: socket.id });
    user.roomId = room.id;
    socket.join(room.id);
    io.to(room.id).emit('room_updated', getRoomSafe(room.id));
    broadcastPublicRooms();
    callback({ success: true, room: getRoomSafe(room.id) });
  });

  socket.on('leave_room', (_, callback) => {
    handleLeaveRoom(socket);
    if (callback) callback({ success: true });
  });

  socket.on('start_game', (_, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback({ error: 'Masada değilsin' });
    const room = rooms.get(user.roomId);
    if (!room) return callback({ error: 'Masa bulunamadı' });
    if (room.hostId !== socket.id) return callback({ error: 'Sadece host başlatabilir' });
    if (room.state !== 'waiting') return callback({ error: 'Oyun zaten başlamış' });
    const config = GAME_CONFIG[room.gameId];
    if (config && config.maxPlayers > 1 && room.players.length < config.maxPlayers)
      return callback({ error: 'Yeterli oyuncu yok' });
    room.state = 'playing';
    room.gameState = initGameState(room.gameId);
    io.to(room.id).emit('game_started', getRoomSafe(room.id));
    broadcastPublicRooms();
    callback({ success: true });
  });

  socket.on('game_move', function(data, callback) {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback && callback({ error: 'Masada değilsin' });
    socket.to(user.roomId).emit('game_move', { ...data, senderId: user.id });
    if (callback) callback({ success: true });
  });

  socket.on('xox_move', ({ cellIndex }, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback({ error: 'Masada değilsin' });
    const room = rooms.get(user.roomId);
    if (!room || room.gameId !== 'xox' || room.state !== 'playing') return callback({ error: 'Geçersiz oyun durumu' });
    const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex === -1) return callback({ error: 'Bu masada değilsin' });
    const result = processXOXMove(room, playerIndex, cellIndex);
    if (result.error) return callback({ error: result.error });
    io.to(room.id).emit('game_state_updated', { gameState: room.gameState, state: room.state });
    if (result.finished) {
      io.to(room.id).emit('game_finished', {
        winner: room.gameState.winner, winLine: room.gameState.winLine,
        winnerName: room.gameState.winner === 'draw' ? null : room.players[room.gameState.winner]?.name,
      });
    }
    callback({ success: true });
  });

  socket.on('rps_choice', ({ choice }, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback({ error: 'Masada değilsin' });
    const room = rooms.get(user.roomId);
    if (!room || room.gameId !== 'rps' || room.state !== 'playing') return callback({ error: 'Geçersiz oyun durumu' });
    const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex === -1) return callback({ error: 'Bu masada değilsin' });
    const result = processRPSChoice(room, playerIndex, choice);
    if (result.error) return callback({ error: result.error });
    if (result.waiting) socket.to(room.id).emit('rps_opponent_chose');
    if (result.reveal) {
      io.to(room.id).emit('rps_reveal', {
        choices: room.gameState.choices, roundResult: room.gameState.roundResult,
        scores: room.gameState.scores, gameWinner: room.gameState.gameWinner,
      });
      if (!result.finished) {
        setTimeout(() => {
          resetRPSRound(room);
          io.to(room.id).emit('rps_new_round', { round: room.gameState.round, scores: room.gameState.scores });
        }, 3000);
      }
    }
    callback({ success: true });
  });

  socket.on('restart_game', (_, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback({ error: 'Masada değilsin' });
    const room = rooms.get(user.roomId);
    if (!room) return callback({ error: 'Masa bulunamadı' });
    room.state = 'playing';
    room.gameState = initGameState(room.gameId);
    io.to(room.id).emit('game_started', getRoomSafe(room.id));
    callback({ success: true });
  });

  socket.on('chat_message', ({ message }, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return callback?.({ error: 'Masada değilsin' });
    const room = rooms.get(user.roomId);
    if (!room) return callback?.({ error: 'Masa bulunamadı' });
    const msg = { id: uuidv4(), userId: user.id, name: user.name, message: message.slice(0, 500), timestamp: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat = room.chat.slice(-100);
    io.to(room.id).emit('chat_new_message', msg);
    if (callback) callback({ success: true });
  });

    // Arkadaşı çıkar
  socket.on('remove_friend', async ({ friendId }, callback) => {
    const me = users.get(socket.id);
    if (!me) return callback({ error: 'Kayıtlı değilsin' });
    if (!dbReady()) return callback({ error: 'DB bağlı değil' });
    try {
      await DBUser.findOneAndUpdate({ userId: me.id }, { $pull: { friends: friendId } });
      await DBUser.findOneAndUpdate({ userId: friendId }, { $pull: { friends: me.id } });
      callback({ success: true });
    } catch (err) { callback({ error: 'Hata' }); }
  });

  // Oyun daveti gönder
  socket.on('invite_friend', ({ toUserId, roomId, gameId }, callback) => {
    const me = users.get(socket.id);
    if (!me) return callback && callback({ error: 'Kayıtlı değilsin' });
    const targetSocketId = onlineSockets.get(toUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('game_invite', { fromId: me.id, fromName: me.name, roomId, gameId });
    }
    if (callback) callback({ success: true });
  });
  
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) onlineSockets.delete(user.id);
    handleLeaveRoom(socket);
    users.delete(socket.id);
    console.log(`[-] Ayrıldı: ${socket.id}`);
  });
});

// ============================================================
// REST API
// ============================================================
app.get('/', (req, res) => {
  res.json({ name: 'oyun.club API', version: '2.0.0', status: 'running', rooms: rooms.size, users: users.size });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), db: dbReady() ? 'connected' : 'disconnected' });
});

app.get('/api/rooms', (req, res) => {
  res.json({ rooms: getPublicRoomsList() });
});

app.get('/api/stats', (req, res) => {
  res.json({
    totalRooms: rooms.size, totalUsers: users.size,
    activeGames: [...rooms.values()].filter(r => r.state === 'playing').length,
  });
});

// ============================================================
// BAŞLAT
// ============================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗
  ║     oyun.club Backend v2.0           ║
  ║     Port: ${PORT}                       ║
  ║     DB: ${MONGODB_URI ? 'MongoDB ✅' : 'Bellek ⚠️ '}                ║
  ╚══════════════════════════════════════╝\n`);
});
