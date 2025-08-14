// server.js
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const { v4: uuid } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

/* -------------------- DB setup -------------------- */
const db = new Database(path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  group_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  user_id TEXT NULL,             -- NULL = system
  to_user_id TEXT NULL,          -- whisper target
  type TEXT NOT NULL CHECK (type IN ('system','text','action','whisper')),
  text TEXT NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY(room_id) REFERENCES rooms(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT NULL,
  PRIMARY KEY (room_id, user_id, joined_at)
);
`);

// seed default rooms once
const countRooms = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
if (countRooms === 0) {
  const ins = db.prepare('INSERT INTO rooms (name, group_name, created_at) VALUES (?,?,?)');
  const now = new Date().toISOString();
  ['boy-1','boy-2','boy-3','girl-1','girl-2','girl-3'].forEach(r => {
    ins.run(r, r.startsWith('boy') ? 'boy' : 'girl', now);
  });
}

/* -------------------- prepared statements -------------------- */
const getRoomByName     = db.prepare('SELECT * FROM rooms WHERE name = ?');
const getRoomsByGroup   = db.prepare('SELECT name FROM rooms WHERE group_name = ? ORDER BY id ASC');
const insertRoom        = db.prepare('INSERT INTO rooms (name, group_name, created_at) VALUES (?,?,?)');

const getUserByName     = db.prepare('SELECT * FROM users WHERE name = ?');
const getUserById       = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser        = db.prepare('INSERT INTO users (id, name, created_at) VALUES (?,?,?)');
const updateUserName    = db.prepare('UPDATE users SET name = ? WHERE id = ?');

const insertMessage     = db.prepare(`
  INSERT INTO messages (room_id, user_id, to_user_id, type, text, ts)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const lastMessagesForUser = db.prepare(`
  SELECT m.*, u.name AS fromName, u2.name AS toName
  FROM messages m
  LEFT JOIN users u  ON u.id  = m.user_id
  LEFT JOIN users u2 ON u2.id = m.to_user_id
  WHERE m.room_id = ?
    AND (m.type!='whisper' OR m.user_id = ? OR m.to_user_id = ?)
  ORDER BY m.id ASC
  LIMIT 100
`);
const insertMembership  = db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?,?,?)');
const closeMembership   = db.prepare(`
  UPDATE room_members SET left_at = ?
  WHERE room_id = ? AND user_id = ? AND left_at IS NULL
`);

/* -------------------- Express -------------------- */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// deep-link page
app.get('/selectRoom', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/selectRoom.html'));
});

// auth: create/login by name
app.post('/auth/login', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  let user = getUserByName.get(name);
  if (!user) {
    const id = uuid();
    insertUser.run(id, name, new Date().toISOString());
    user = { id, name };
  }
  res.json({ userId: user.id, name: user.name });
});

// rooms
app.get('/rooms', (req, res) => {
  const { group } = req.query;
  if (!group) return res.status(400).json({ error: 'Invalid group' });
  const rows = getRoomsByGroup.all(group);
  res.json({ rooms: rows.map(r => r.name) });
});

app.post('/rooms', (req, res) => {
  const { group } = req.body;
  if (!group) return res.status(400).json({ error: 'Invalid group' });
  try {
    const existing = getRoomsByGroup.all(group).map(r => r.name);
    const nextIndex = existing.length + 1;
    const name = `${group}-${nextIndex}`;
    insertRoom.run(name, group, new Date().toISOString());
    res.status(201).json({ roomName: name });
  } catch (e) {
    res.status(409).json({ error: 'Room already exists' });
  }
});

// history for a user in a room
app.get('/history', (req, res) => {
  const roomName = req.query.room;
  const userId   = req.query.userId || '';
  const room = getRoomByName.get(roomName);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const rows = lastMessagesForUser.all(room.id, userId, userId);
  res.json({ history: rows });
});

/* -------------------- Socket.IO -------------------- */

// roomName -> Map(userId -> name)
const roomUsers = new Map();
// socketId -> userId
const userSockets = new Map();

const usersList = (roomName) =>
  roomUsers.has(roomName) ? Array.from(roomUsers.get(roomName).values()) : [];

io.on('connection', (socket) => {
  userSockets.set(socket.id, null);

  socket.on('joinRoom', ({ userId, userName, roomId: roomName }) => {
    // guard: already in this room
    if (socket.data?.roomName === roomName) return;

    // ensure user
    let user = userId ? getUserById.get(userId) : null;
    if (!user) {
      const id = uuid();
      insertUser.run(id, userName, new Date().toISOString());
      user = { id, name: userName };
    }
    userSockets.set(socket.id, user.id);

    // room
    const room = getRoomByName.get(roomName);
    if (!room) return;

    // join socket room
    socket.join(roomName);
    socket.data = { roomName, userId: user.id, userName: user.name, hasLeft: false };

    // track members
    if (!roomUsers.has(roomName)) roomUsers.set(roomName, new Map());
    roomUsers.get(roomName).set(user.id, user.name);

    const ts = new Date().toLocaleString();

    // 1) send history BEFORE logging the join → no duplicate join lines
    const history = lastMessagesForUser.all(room.id, user.id, user.id).map(rowToPayload);
    io.to(socket.id).emit('history', { history });

    // 2) persist membership + system join and broadcast ONCE
    insertMembership.run(room.id, user.id, new Date().toISOString());
    insertMessage.run(room.id, null, null, 'system', `${user.name} has joined this room`, new Date().toISOString());
    io.to(roomName).emit('systemMessage', { text: `${user.name} has joined this room`, timestamp: ts });

    // 3) update member list
    io.to(roomName).emit('roomUsers', { users: usersList(roomName) });
  });

  socket.on('sendMessage', ({ userName, roomId, message }) => {
    const { userId } = socket.data || {};
    const room = getRoomByName.get(roomId);
    if (!room || !userId) return;
    const ts = new Date().toLocaleTimeString();

    insertMessage.run(room.id, userId, null, 'text', message, new Date().toISOString());
    io.to(roomId).emit('receiveMessage', { userName, message, timestamp: ts });
  });

  // command-like features
  socket.on('clientCommand', ({ roomId, input }) => {
    const userId = socket.data?.userId || null;
    const roomName = roomId;
    const room = getRoomByName.get(roomName);
    if (!room || !userId) return;

    const ts = new Date().toLocaleTimeString();
    const me = getUserById.get(userId);

    const [cmd, ...rest] = input.trim().slice(1).split(' ');
    const argStr = rest.join(' ').trim();

    if (cmd === 'leave') {
      handleLeave(socket);
      io.to(socket.id).emit('leftRoom', { roomId });
      return;
    }

    if (cmd === 'nick') {
      const newName = argStr;
      if (!newName) return io.to(socket.id).emit('nickError', { message: 'Usage: /nick <newName>' });
      const exists = getUserByName.get(newName);
      if (exists) return io.to(socket.id).emit('nickError', { message: 'Name already taken' });

      const oldName = me.name;
      updateUserName.run(newName, me.id);

      if (roomUsers.has(roomName)) roomUsers.get(roomName).set(me.id, newName);

      insertMessage.run(room.id, null, null, 'system', `${oldName} is now known as ${newName}`, new Date().toISOString());
      io.to(roomName).emit('systemMessage', { text: `${oldName} is now known as ${newName}`, timestamp: new Date().toLocaleString() });
      io.to(roomName).emit('roomUsers', { users: usersList(roomName) });

      // update socket
      socket.data.userName = newName;
      io.to(socket.id).emit('nickOk', { newName });
      return;
    }

    if (cmd === 'w' || cmd === 'whisper') {
      const [target, ...msgArr] = argStr.split(' ');
      const text = msgArr.join(' ').trim();
      if (!target || !text) {
        return io.to(socket.id).emit('systemMessage', { text: 'Usage: /w <username> <message>', timestamp: new Date().toLocaleString() });
      }
      const map = roomUsers.get(roomName) || new Map();
      let toUserId = null, toUserName = null;
      for (const [id, nm] of map.entries()) {
        if (nm === target) { toUserId = id; toUserName = nm; break; }
      }
      if (!toUserId) {
        return io.to(socket.id).emit('systemMessage', { text: `User "${target}" not found`, timestamp: new Date().toLocaleString() });
      }

      insertMessage.run(room.id, me.id, toUserId, 'whisper', text, new Date().toISOString());

      const payloadToSender   = { fromName: me.name, toName: toUserName, message: text, timestamp: ts, toSelf: true };
      const payloadToReceiver = { fromName: me.name, toName: toUserName, message: text, timestamp: ts, toSelf: false };

      io.to(socket.id).emit('whisper', payloadToSender);
      for (const [sid, uid] of userSockets.entries()) {
        if (uid === toUserId) io.to(sid).emit('whisper', payloadToReceiver);
      }
      return;
    }

    if (cmd === 'me') {
      const text = argStr || '';
      insertMessage.run(room.id, me.id, null, 'action', text, new Date().toISOString());
      io.to(roomName).emit('emoteMessage', { text: `${me.name} ${text}`, timestamp: ts });
      return;
    }

    io.to(socket.id).emit('systemMessage', { text: `Unknown command: /${cmd}`, timestamp: new Date().toLocaleString() });
  });

  const handleLeave = (sock = socket) => {
    const data = sock.data || {};
    if (!data.roomName || data.hasLeft) return;   // idempotent
    sock.data.hasLeft = true;

    const roomName = data.roomName;
    const room = getRoomByName.get(roomName);
    const userId = data.userId;
    const userName = data.userName;
    if (!room || !userId) return;

    closeMembership.run(room.id, userId, new Date().toISOString());
    insertMessage.run(room.id, null, null, 'system', `${userName} left the room`, new Date().toISOString());

    sock.leave(roomName);

    if (roomUsers.has(roomName)) {
      roomUsers.get(roomName).delete(userId);
      if (roomUsers.get(roomName).size === 0) roomUsers.delete(roomName);
    }

    io.to(roomName).emit('systemMessage', { text: `${userName} left the room`, timestamp: new Date().toLocaleString() });
    io.to(roomName).emit('roomUsers', { users: usersList(roomName) });

    // clear per-socket data
    sock.data.roomName = null;
  };

  socket.on('leaveRoom', () => handleLeave(socket));
  socket.on('disconnect', () => {
    handleLeave(socket);
    userSockets.delete(socket.id);
  });
});

/* -------------------- helpers -------------------- */
function rowToPayload(r) {
  const ts = new Date(r.ts).toLocaleString();
  if (r.type === 'system')  return { kind: 'system',  timestamp: ts, text: r.text };
  if (r.type === 'action')  return { kind: 'emote',   timestamp: ts, text: `${r.fromName || ''} ${r.text}` };
  if (r.type === 'whisper') return { kind: 'whisper', timestamp: ts, fromName: r.fromName, toName: r.toName, text: r.text };
  return { kind: 'text',    timestamp: ts, fromName: r.fromName, text: r.text };
}

/* -------------------- start -------------------- */
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
