const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const tables = new Map();
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(rank) {
  if (rank === 'A') return 11;
  if (['J','Q','K'].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function handTotal(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    total += cardValue(c.rank);
    if (c.rank === 'A') aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function createTable(id) {
  return {
    id,
    players: [],        
    deck: [],
    phase: 'waiting',   
    currentPlayerIndex: 0,
    roundResult: null
  };
}

function startRound(table) {
  table.deck = createDeck();
  table.phase = 'playing';
  table.currentPlayerIndex = 0;
  table.roundResult = null;

  for (const p of table.players) {
    p.hand = [table.deck.pop(), table.deck.pop()];
    p.stood = false;
    p.busted = handTotal(p.hand) > 21;
  }

  advanceIfDone(table);
  broadcast(table);
}

function advanceIfDone(table) {
  while (table.currentPlayerIndex < table.players.length) {
    const p = table.players[table.currentPlayerIndex];
    if (!p.stood && !p.busted) break;
    table.currentPlayerIndex++;
  }
  if (table.currentPlayerIndex >= table.players.length) {
    endRound(table);
  }
}

function endRound(table) {
  table.phase = 'finished';
  
  const results = table.players.map(p => {
    const pTotal = handTotal(p.hand);
    return { playerId: p.id, name: p.name, total: pTotal, busted: p.busted };
  });

  let maxTotal = -1;
  let winners = [];
  
  results.forEach(r => {
    if (!r.busted) {
      if (r.total > maxTotal) {
        maxTotal = r.total;
        winners = [r.name];
      } else if (r.total === maxTotal) {
        winners.push(r.name);
      }
    }
  });

  let winnerText = winners.length > 0 ? `Победил(и): ${winners.join(', ')}` : 'Все перебрали!';
  
  table.roundResult = { players: results, winnerText };
  broadcast(table);
}

function broadcast(table) {
  for (const p of table.players) {
    const socket = io.sockets.sockets.get(p.id);
    if (!socket) continue;

    const playersForThisSocket = table.players.map(pl => {
      const isMe = pl.id === p.id;
      const revealCards = isMe || table.phase === 'finished';
      
      return {
        id: pl.id,
        name: pl.name,
        hand: revealCards ? pl.hand : pl.hand.map(() => ({ suit: '?', rank: '?' })),
        total: revealCards ? handTotal(pl.hand) : null,
        stood: pl.stood,
        busted: pl.busted
      };
    });

    const state = {
      id: table.id,
      phase: table.phase,
      players: playersForThisSocket,
      currentPlayerId: table.players[table.currentPlayerIndex]?.id || null,
      roundResult: table.roundResult
    };
    socket.emit('tableState', state);
  }
}

io.on('connection', (socket) => {
  socket.on('joinTable', ({ tableId, playerName }) => {
    let table = tables.get(tableId);
    if (!table) {
      table = createTable(tableId);
      tables.set(tableId, table);
    }

    if (table.players.length >= 5) {
      socket.emit('errorMsg', 'Стол заполнен (максимум 5 игроков)');
      return;
    }
    if (table.phase === 'playing') {
      socket.emit('errorMsg', 'Раунд уже идёт, подождите следующего');
      return;
    }

    const player = {
      id: socket.id,
      name: playerName || `Игрок ${table.players.length + 1}`,
      hand: [],
      stood: false,
      busted: false
    };
    table.players.push(player);
    socket.join(tableId);
    socket.tableId = tableId;

    broadcast(table);

    if (table.phase === 'waiting' && table.players.length >= 2) {
      startRound(table);
    }
  });

  socket.on('hit', () => {
    const table = tables.get(socket.tableId);
    if (!table || table.phase !== 'playing') return;
    const p = table.players[table.currentPlayerIndex];
    // Убрана проверка на p.busted, чтобы можно было брать карты при переборе
    if (!p || p.id !== socket.id || p.stood) return;

    p.hand.push(table.deck.pop());
    if (handTotal(p.hand) > 21) p.busted = true;

    // Если перебрал, передаем ход дальше (но кнопки все равно останутся, пока ход не перейдет)
    if (p.busted) {
      table.currentPlayerIndex++;
      advanceIfDone(table);
    }
    broadcast(table);
  });

  socket.on('stand', () => {
    const table = tables.get(socket.tableId);
    if (!table || table.phase !== 'playing') return;
    const p = table.players[table.currentPlayerIndex];
    if (!p || p.id !== socket.id || p.stood || p.busted) return;

    p.stood = true;
    table.currentPlayerIndex++;
    advanceIfDone(table);
    broadcast(table);
  });

  socket.on('nextRound', () => {
    const table = tables.get(socket.tableId);
    if (!table || table.phase !== 'finished') return;
    for (const p of table.players) {
      p.hand = [];
      p.stood = false;
      p.busted = false;
    }
    table.roundResult = null;
    startRound(table);
  });

  socket.on('disconnect', () => {
    const tableId = socket.tableId;
    if (!tableId) return;
    const table = tables.get(tableId);
    if (!table) return;

    table.players = table.players.filter(p => p.id !== socket.id);
    if (table.players.length === 0) {
      tables.delete(tableId);
    } else {
      if (table.phase === 'playing') {
        table.currentPlayerIndex = Math.min(
          table.currentPlayerIndex,
          table.players.length - 1
        );
        advanceIfDone(table);
      }
      broadcast(table);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});