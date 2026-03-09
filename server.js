const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Game rooms storage
const rooms = {};

function createBoard() {
  // Standard backgammon starting position
  // positive = white, negative = black
  const points = new Array(24).fill(0);
  // White pieces
  points[0] = 2;
  points[11] = 5;
  points[16] = 3;
  points[18] = 5;
  // Black pieces
  points[23] = -2;
  points[12] = -5;
  points[7] = -3;
  points[5] = -5;
  return points;
}

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function createGame() {
  return {
    board: createBoard(),
    dice: [],
    movesLeft: [],
    currentPlayer: 'white',
    phase: 'rolling', // rolling, moving, gameover
    whiteBar: 0,
    blackBar: 0,
    whiteBorne: 0,
    blackBorne: 0,
    winner: null,
    selectedPoint: null,
    validMoves: []
  };
}

function getValidMoves(game, fromPoint) {
  const moves = [];
  const isWhite = game.currentPlayer === 'white';
  const dir = isWhite ? 1 : -1;
  const bar = isWhite ? game.whiteBar : game.blackBar;

  if (bar > 0 && fromPoint !== 'bar') return [];

  const uniqueMoves = [...new Set(game.movesLeft)];

  for (const die of uniqueMoves) {
    if (fromPoint === 'bar') {
      const to = isWhite ? die - 1 : 24 - die;
      const pointCount = game.board[to];
      const opponentBlocked = isWhite ? (pointCount < -1) : (pointCount > 1);
      if (!opponentBlocked) {
        moves.push(to);
      }
    } else {
      const to = fromPoint + dir * die;
      if (to >= 0 && to <= 23) {
        const pointCount = game.board[to];
        const opponentBlocked = isWhite ? (pointCount < -1) : (pointCount > 1);
        if (!opponentBlocked) {
          moves.push(to);
        }
      } else if (canBearOff(game)) {
        // Bearing off
        moves.push('off');
      }
    }
  }

  return [...new Set(moves)];
}

function canBearOff(game) {
  const isWhite = game.currentPlayer === 'white';
  const homeStart = isWhite ? 18 : 0;
  const homeEnd = isWhite ? 23 : 5;

  if (isWhite && game.whiteBar > 0) return false;
  if (!isWhite && game.blackBar > 0) return false;

  for (let i = 0; i < 24; i++) {
    if (isWhite && i < homeStart && game.board[i] > 0) return false;
    if (!isWhite && i > homeEnd && game.board[i] < 0) return false;
  }
  return true;
}

function applyMove(game, from, to) {
  const isWhite = game.currentPlayer === 'white';
  const dir = isWhite ? 1 : -1;

  let dieUsed;
  if (from === 'bar') {
    dieUsed = isWhite ? (to + 1) : (24 - to);
  } else if (to === 'off') {
    dieUsed = isWhite ? (24 - from) : (from + 1);
    // Find closest die
    const remaining = isWhite ? 24 - from : from + 1;
    const exact = game.movesLeft.find(d => d === remaining);
    dieUsed = exact || game.movesLeft.find(d => d >= remaining);
  } else {
    dieUsed = Math.abs(to - from);
  }

  const moveIdx = game.movesLeft.indexOf(dieUsed);
  if (moveIdx !== -1) game.movesLeft.splice(moveIdx, 1);

  if (from === 'bar') {
    if (isWhite) game.whiteBar--;
    else game.blackBar--;
  } else {
    if (isWhite) game.board[from]--;
    else game.board[from]++;
  }

  if (to === 'off') {
    if (isWhite) game.whiteBorne++;
    else game.blackBorne++;
  } else {
    const target = game.board[to];
    // Hit opponent
    if (isWhite && target === -1) {
      game.board[to] = 0;
      game.blackBar++;
    } else if (!isWhite && target === 1) {
      game.board[to] = 0;
      game.whiteBar++;
    }
    if (isWhite) game.board[to]++;
    else game.board[to]--;
  }

  // Check win
  if (game.whiteBorne >= 15) {
    game.phase = 'gameover';
    game.winner = 'white';
  } else if (game.blackBorne >= 15) {
    game.phase = 'gameover';
    game.winner = 'black';
  }

  if (game.movesLeft.length === 0 && game.phase !== 'gameover') {
    switchTurn(game);
  }

  return game;
}

function switchTurn(game) {
  game.currentPlayer = game.currentPlayer === 'white' ? 'black' : 'white';
  game.phase = 'rolling';
  game.selectedPoint = null;
  game.validMoves = [];
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        game: null,
        spectators: []
      };
    }

    const room = rooms[roomId];

    if (room.players.length < 2) {
      const color = room.players.length === 0 ? 'white' : 'black';
      room.players.push({ id: socket.id, name: playerName, color });
      socket.join(roomId);
      socket.roomId = roomId;
      socket.color = color;

      socket.emit('joined', { color, roomId });

      if (room.players.length === 2) {
        room.game = createGame();
        io.to(roomId).emit('gameStart', {
          game: room.game,
          players: room.players.map(p => ({ name: p.name, color: p.color }))
        });
      } else {
        socket.emit('waiting', { message: 'Rəqib gözlənilir...' });
      }
    } else {
      socket.emit('roomFull', { message: 'Otaq doludur' });
    }
  });

  socket.on('rollDice', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.game) return;
    const game = room.game;
    if (game.phase !== 'rolling') return;
    const playerColor = room.players.find(p => p.id === socket.id)?.color;
    if (playerColor !== game.currentPlayer) return;

    const d1 = rollDie();
    const d2 = rollDie();
    game.dice = [d1, d2];
    game.movesLeft = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
    game.phase = 'moving';

    io.to(roomId).emit('diceRolled', { game });
  });

  socket.on('selectPoint', ({ roomId, point }) => {
    const room = rooms[roomId];
    if (!room || !room.game) return;
    const game = room.game;
    const playerColor = room.players.find(p => p.id === socket.id)?.color;
    if (playerColor !== game.currentPlayer) return;
    if (game.phase !== 'moving') return;

    game.selectedPoint = point;
    game.validMoves = getValidMoves(game, point);
    io.to(roomId).emit('pointSelected', { game });
  });

  socket.on('makeMove', ({ roomId, from, to }) => {
    const room = rooms[roomId];
    if (!room || !room.game) return;
    const game = room.game;
    const playerColor = room.players.find(p => p.id === socket.id)?.color;
    if (playerColor !== game.currentPlayer) return;

    applyMove(game, from, to);
    game.selectedPoint = null;
    game.validMoves = [];

    io.to(roomId).emit('moveMade', { game });
  });

  socket.on('skipTurn', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.game) return;
    const game = room.game;
    const playerColor = room.players.find(p => p.id === socket.id)?.color;
    if (playerColor !== game.currentPlayer) return;

    switchTurn(game);
    io.to(roomId).emit('turnSkipped', { game });
  });

  socket.on('playAgain', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.game = createGame();
    io.to(roomId).emit('gameStart', {
      game: room.game,
      players: room.players.map(p => ({ name: p.name, color: p.color }))
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      room.players = room.players.filter(p => p.id !== socket.id);
      io.to(roomId).emit('playerLeft', { message: 'Rəqib oyundan çıxdı' });
      if (room.players.length === 0) {
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Nərd Oyunu serveri port ${PORT}-də işləyir`);
});
