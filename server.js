const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// Single global room
const room = {
  players: [],   // max 2: [{id, name, color, score}]
  queue: [],     // waiting players: [{id, name}]
  spectators: [], // [{id, name}]
  game: null
};

function getRoomInfo() {
  return {
    players: room.players.map(p => ({ name: p.name, color: p.color, score: p.score })),
    queue: room.queue.map(q => ({ name: q.name })),
    spectators: room.spectators.map(s => ({ name: s.name })),
    gameActive: !!room.game && room.game.phase !== 'gameover'
  };
}

function broadcastRoomInfo() {
  io.emit('roomInfo', getRoomInfo());
}

// Board logic
function createBoard() {
  const p = new Array(24).fill(0);
  p[0]=2; p[11]=5; p[16]=3; p[18]=5;
  p[23]=-2; p[12]=-5; p[7]=-3; p[5]=-5;
  return p;
}
function rollDie() { return Math.floor(Math.random()*6)+1; }
function createGame() {
  return {
    board: createBoard(), dice: [], movesLeft: [],
    currentPlayer: 'white', phase: 'rolling',
    whiteBar: 0, blackBar: 0, whiteBorne: 0, blackBorne: 0,
    winner: null, selectedPoint: null, validMoves: []
  };
}

function getValidMoves(game, fromPoint) {
  const isWhite = game.currentPlayer === 'white';
  const bar = isWhite ? game.whiteBar : game.blackBar;
  if (bar > 0 && fromPoint !== 'bar') return [];
  const moves = [];
  const unique = [...new Set(game.movesLeft)];
  for (const die of unique) {
    if (fromPoint === 'bar') {
      const to = isWhite ? die-1 : 24-die;
      if (to>=0 && to<=23) {
        const cnt = game.board[to];
        if (!(isWhite ? cnt<-1 : cnt>1)) moves.push(to);
      }
    } else {
      const dir = isWhite ? 1 : -1;
      const to = fromPoint + dir*die;
      if (to>=0 && to<=23) {
        const cnt = game.board[to];
        if (!(isWhite ? cnt<-1 : cnt>1)) moves.push(to);
      } else if (canBearOff(game)) {
        moves.push('off');
      }
    }
  }
  return [...new Set(moves)];
}

function canBearOff(game) {
  const isWhite = game.currentPlayer === 'white';
  if (isWhite && game.whiteBar > 0) return false;
  if (!isWhite && game.blackBar > 0) return false;
  const homeStart = isWhite ? 18 : 0;
  const homeEnd = isWhite ? 23 : 5;
  for (let i=0; i<24; i++) {
    if (isWhite && i<homeStart && game.board[i]>0) return false;
    if (!isWhite && i>homeEnd && game.board[i]<0) return false;
  }
  return true;
}

function applyMove(game, from, to) {
  const isWhite = game.currentPlayer === 'white';
  let dieUsed;
  if (from==='bar') dieUsed = isWhite ? to+1 : 24-to;
  else if (to==='off') {
    const rem = isWhite ? 24-from : from+1;
    dieUsed = game.movesLeft.find(d=>d===rem) || game.movesLeft.find(d=>d>=rem);
  } else dieUsed = Math.abs(to-from);

  const idx = game.movesLeft.indexOf(dieUsed);
  if (idx!==-1) game.movesLeft.splice(idx,1);

  if (from==='bar') { if(isWhite) game.whiteBar--; else game.blackBar--; }
  else { if(isWhite) game.board[from]--; else game.board[from]++; }

  if (to==='off') { if(isWhite) game.whiteBorne++; else game.blackBorne++; }
  else {
    const tgt = game.board[to];
    if (isWhite && tgt===-1) { game.board[to]=0; game.blackBar++; }
    else if (!isWhite && tgt===1) { game.board[to]=0; game.whiteBar++; }
    if(isWhite) game.board[to]++; else game.board[to]--;
  }

  if (game.whiteBorne>=15) { game.phase='gameover'; game.winner='white'; }
  else if (game.blackBorne>=15) { game.phase='gameover'; game.winner='black'; }

  if (game.movesLeft.length===0 && game.phase!=='gameover') switchTurn(game);
  return game;
}

function switchTurn(game) {
  game.currentPlayer = game.currentPlayer==='white' ? 'black' : 'white';
  game.phase = 'rolling'; game.selectedPoint=null; game.validMoves=[];
}

function startGame() {
  if (room.players.length < 2) return;
  room.game = createGame();
  room.players[0].score = room.players[0].score || 0;
  room.players[1].score = room.players[1].score || 0;
  io.emit('gameStart', {
    game: room.game,
    players: room.players.map(p=>({name:p.name,color:p.color,score:p.score}))
  });
  broadcastRoomInfo();
}

function tryPromoteQueue() {
  if (room.players.length < 2 && room.queue.length > 0) {
    const next = room.queue.shift();
    const color = room.players.length===0 ? 'white' : 'black';
    room.players.push({ id: next.id, name: next.name, color, score: 0 });
    const sock = io.sockets.sockets.get(next.id);
    if (sock) {
      sock.role = 'player';
      sock.color = color;
      sock.emit('promoted', { color, message: 'Sıraya çatdınız! Oyunçu oldunuz!' });
    }
    broadcastRoomInfo();
    if (room.players.length===2) startGame();
  }
}

function removeUser(socketId) {
  const wasPlayer = room.players.find(p=>p.id===socketId);
  room.players = room.players.filter(p=>p.id!==socketId);
  room.queue = room.queue.filter(q=>q.id!==socketId);
  room.spectators = room.spectators.filter(s=>s.id!==socketId);

  if (wasPlayer && room.game && room.game.phase!=='gameover') {
    room.game = null;
    io.emit('playerLeft', { message: wasPlayer.name+' oyundan çıxdı. Oyun dayandırıldı.' });
    tryPromoteQueue();
  } else if (!wasPlayer) {
    // was queue or spectator
  }
  broadcastRoomInfo();
}

io.on('connection', (socket) => {
  socket.on('join', ({ name }) => {
    socket.name = name;
    socket.join('main');

    if (room.players.length < 2) {
      const color = room.players.length===0 ? 'white' : 'black';
      room.players.push({ id: socket.id, name, color, score: 0 });
      socket.role = 'player';
      socket.color = color;
      socket.emit('joined', { role: 'player', color });

      if (room.players.length===2) {
        startGame();
      } else {
        socket.emit('waiting', { message: 'Rəqib gözlənilir...' });
        broadcastRoomInfo();
      }
    } else {
      // Add to queue
      room.queue.push({ id: socket.id, name });
      socket.role = 'queue';
      const pos = room.queue.length;
      socket.emit('joined', { role: 'queue', queuePos: pos });
      broadcastRoomInfo();

      // Send current game state if active
      if (room.game) {
        socket.emit('gameStart', {
          game: room.game,
          players: room.players.map(p=>({name:p.name,color:p.color,score:p.score}))
        });
      }
    }

    // Send room info
    socket.emit('roomInfo', getRoomInfo());

    // Announce join
    io.emit('chatMsg', {
      type: 'system',
      text: `👋 ${name} otağa qatıldı`
    });
  });

  socket.on('becomeSpectator', () => {
    // Remove from queue
    room.queue = room.queue.filter(q=>q.id!==socket.id);
    if (!room.spectators.find(s=>s.id===socket.id)) {
      room.spectators.push({ id: socket.id, name: socket.name });
    }
    socket.role = 'spectator';
    socket.emit('joined', { role: 'spectator' });
    broadcastRoomInfo();
    if (room.game) {
      socket.emit('gameStart', {
        game: room.game,
        players: room.players.map(p=>({name:p.name,color:p.color,score:p.score}))
      });
    }
  });

  socket.on('rollDice', () => {
    if (socket.role!=='player') return;
    if (!room.game || room.game.phase!=='rolling') return;
    const p = room.players.find(p=>p.id===socket.id);
    if (!p || p.color!==room.game.currentPlayer) return;
    const d1=rollDie(), d2=rollDie();
    room.game.dice=[d1,d2];
    room.game.movesLeft=d1===d2?[d1,d1,d1,d1]:[d1,d2];
    room.game.phase='moving';
    io.emit('diceRolled', { game: room.game });
  });

  socket.on('selectPoint', ({ point }) => {
    if (socket.role!=='player') return;
    if (!room.game || room.game.phase!=='moving') return;
    const p = room.players.find(p=>p.id===socket.id);
    if (!p || p.color!==room.game.currentPlayer) return;
    room.game.selectedPoint = point;
    room.game.validMoves = getValidMoves(room.game, point);
    io.emit('pointSelected', { game: room.game });
  });

  socket.on('makeMove', ({ from, to }) => {
    if (socket.role!=='player') return;
    if (!room.game) return;
    const p = room.players.find(p=>p.id===socket.id);
    if (!p || p.color!==room.game.currentPlayer) return;
    let wasHit=false;
    if (typeof to==='number') {
      const cnt=room.game.board[to];
      wasHit=room.game.currentPlayer==='white'?cnt===-1:cnt===1;
    }
    applyMove(room.game, from, to);
    room.game.selectedPoint=null; room.game.validMoves=[];

    if (room.game.phase==='gameover') {
      const winner = room.players.find(p=>p.color===room.game.winner);
      if (winner) winner.score=(winner.score||0)+1;
      io.emit('moveMade', { game: room.game, wasHit });
      broadcastRoomInfo();
    } else {
      io.emit('moveMade', { game: room.game, wasHit });
    }
  });

  socket.on('skipTurn', () => {
    if (socket.role!=='player') return;
    if (!room.game) return;
    const p = room.players.find(p=>p.id===socket.id);
    if (!p || p.color!==room.game.currentPlayer) return;
    switchTurn(room.game);
    io.emit('turnSkipped', { game: room.game });
  });

  socket.on('playAgain', () => {
    if (socket.role!=='player') return;
    if (room.players.length<2) return;
    // Swap colors for fairness
    room.players.forEach(p=>{ p.color=p.color==='white'?'black':'white'; });
    startGame();
  });

  socket.on('chatMsg', ({ text }) => {
    if (!text || text.trim().length===0) return;
    const role = socket.role==='player' ? '🎮' : socket.role==='spectator' ? '👁' : '⏳';
    io.emit('chatMsg', {
      type: 'user',
      name: socket.name,
      role,
      text: text.trim().substring(0, 120)
    });
  });

  socket.on('reaction', ({ emoji }) => {
    const allowed = ['🔥','👏','😮','😂','❤️','💪','🎲','🤯'];
    if (!allowed.includes(emoji)) return;
    io.emit('reaction', { name: socket.name, emoji });
  });

  socket.on('disconnect', () => {
    if (socket.name) {
      io.emit('chatMsg', { type:'system', text:`👋 ${socket.name} ayrıldı` });
    }
    removeUser(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Nərd serveri port ${PORT}-də işləyir`));
