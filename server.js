// server.js
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ห้องเริ่มต้น
const roomGroups = {
  boy: ['boy-1', 'boy-2', 'boy-3'],
  girl: ['girl-1', 'girl-2', 'girl-3'],
};

// เก็บรายชื่อผู้ใช้ต่อห้อง
const roomUsers = new Map(); // roomId -> Set(userName)

// ---------- HTTP ROUTES ----------
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// หน้าเลือกห้อง
app.get('/selectRoom', (req, res) => {
  const { group, name } = req.query;
  if (!group || !name || !roomGroups[group]) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public/selectRoom.html'));
});

// ดึงรายการห้องของกลุ่ม (เหมือนเดิม)
app.get('/rooms', (req, res) => {
  const { group } = req.query;
  if (!group || !roomGroups[group]) return res.status(400).json({ error: 'Invalid group' });
  res.json({ rooms: roomGroups[group] });
});

// เพิ่มห้องใหม่ให้กลุ่ม (ยอมรับ group จาก body หรือ query)
app.post('/rooms', (req, res) => {
  const group = (req.body && req.body.group) || req.query.group; // << สำคัญ
  if (!group || !roomGroups[group]) {
    return res.status(400).json({ error: 'Invalid group', got: req.body });
  }
  const nextIndex = roomGroups[group].length + 1;
  const newRoom = `${group}-${nextIndex}`;
  roomGroups[group].push(newRoom);
  return res.status(201).json({ roomName: newRoom, rooms: roomGroups[group] });
});

// ให้ของเดิม /addRoom ยังใช้ได้ (ชี้ไป handler เดียวกัน)
app.post('/addRoom', (req, res) => {
  req.url = '/rooms' + (req.query.group ? `?group=${req.query.group}` : '');
  app._router.handle(req, res);
});

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
  socket.on('joinRoom', ({ userName, roomId }) => {
    socket.userName = userName;
    socket.roomId = roomId;
    socket.join(roomId);

    if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Set());
    roomUsers.get(roomId).add(userName);

    const ts = new Date().toLocaleString();

    // ส่ง system message ให้ทั้งห้อง (รวมคนที่เพิ่งเข้า)
    io.to(roomId).emit('systemMessage', {
      text: `${userName} has joined this room`,
      timestamp: ts
    });

    // ส่งสถานะเชื่อมต่อให้คนที่เพิ่งเข้า (เอาไว้โชว์เวลา connect)
    io.to(socket.id).emit('connectionInfo', {
      connectedAt: ts
    });

    // อัปเดตสมาชิกทั้งห้อง
    io.to(roomId).emit('roomUsers', {
      users: Array.from(roomUsers.get(roomId))
    });
  });

  socket.on('sendMessage', ({ userName, roomId, message }) => {
    const ts = new Date().toLocaleTimeString();
    io.to(roomId).emit('receiveMessage', { userName, message, timestamp: ts });
  });

  const handleLeave = () => {
    const { userName, roomId } = socket;
    if (!roomId) return;
    const ts = new Date().toLocaleString();

    if (roomUsers.has(roomId)) {
      roomUsers.get(roomId).delete(userName);
      if (roomUsers.get(roomId).size === 0) roomUsers.delete(roomId);
    }

    socket.leave(roomId);

    // แจ้งระบบ + อัปเดตรายชื่อให้ทั้งห้อง
    io.to(roomId).emit('systemMessage', {
      text: `${userName} left the room`,
      timestamp: ts
    });
    io.to(roomId).emit('roomUsers', {
      users: Array.from(roomUsers.get(roomId) || [])
    });

    socket.roomId = null;
  };

  socket.on('leaveRoom', handleLeave);
  socket.on('disconnect', handleLeave);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
