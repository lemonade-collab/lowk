// ============================================================
// ROYAL HOLD'EM — Texas Hold'em Multiplayer (PeerJS/WebRTC)
// ============================================================

// ---- Globals ----
let peer = null;
let myPeerId = null;
let myName = '';
let isHost = false;
let roomCode = '';
let connections = {}; // peerId -> DataConnection
let gameState = null;
let myPlayerId = null; // seat index
let heartbeatInterval = null;

// PeerJS Configuration
const PEER_CONFIG = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  debug: 1,
  config: {
    'iceServers': [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

// ---- Tab switching ----
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 && tab === 'host') || (i === 1 && tab === 'join'));
  });
  document.getElementById('tab-host').classList.toggle('active', tab === 'host');
  document.getElementById('tab-join').classList.toggle('active', tab === 'join');
}

// ---- Peer Lifecycle Management ----
function cleanupPeer() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (peer) {
    peer.destroy();
    peer = null;
  }
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (peer && !peer.destroyed && !peer.disconnected) {
      peer.socket.send({ type: 'HEARTBEAT' });
    }
  }, 5000);
}

// ---- Lobby: Host ----
function hostGame() {
  const nameEl = document.getElementById('host-name');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) { setStatus('host', 'Please enter your name.'); return; }
  
  myName = name;
  isHost = true;
  initPeer('host');
}

// ---- Lobby: Join ----
function joinGame() {
  const nameEl = document.getElementById('join-name');
  const codeEl = document.getElementById('join-code');
  const name = nameEl ? nameEl.value.trim() : '';
  const code = codeEl ? codeEl.value.trim() : '';
  
  if (!name || !code) { setStatus('join', 'Enter name and room code.'); return; }

  myName = name;
  isHost = false;
  roomCode = code.trim();
  initPeer('join');
}

function initPeer(mode) {
  cleanupPeer();
  setStatus(mode, 'Connecting to signaling server...');
  
  peer = new Peer(undefined, PEER_CONFIG);

  peer.on('open', id => {
    myPeerId = id;
    startHeartbeat();
    
    if (mode === 'host') {
      roomCode = id;
      const codeText = document.getElementById('room-code-text');
      if (codeText) codeText.textContent = id;
      document.getElementById('room-code-display')?.classList.remove('hidden');
      setStatus('host', 'Table live. Waiting for friends.');
      updateWaitingList([myName]);
      myPlayerId = 0;
    } else {
      attemptConnection(roomCode);
    }
  });

  peer.on('connection', conn => {
    if (isHost) handleHostConnection(conn);
  });

  peer.on('disconnected', () => {
    console.log('Peer disconnected from server. Reconnecting...');
    peer.reconnect();
  });

  peer.on('error', err => {
    console.error('PeerJS Error Type:', err.type);
    const target = isHost ? 'host' : 'join';
    
    if (err.type === 'network' || err.type === 'socket-error') {
      setStatus(target, 'Network busy. Retrying connection...');
      setTimeout(() => { if (!peer || peer.destroyed) initPeer(mode); }, 3000);
    } else if (err.type === 'peer-not-found') {
      setStatus('join', 'Room code not found. Check the code and try again.');
    } else {
      setStatus(target, `Status: ${err.type}`);
    }
  });
}

function attemptConnection(hostId) {
  setStatus('join', `Contacting table ${hostId}...`);
  
  const conn = peer.connect(hostId, {
    metadata: { name: myName },
    reliable: true
  });

  const connTimeout = setTimeout(() => {
    if (!connections[hostId]) {
      setStatus('join', 'Connection timed out. Host might be offline.');
    }
  }, 10000);

  conn.on('open', () => {
    clearTimeout(connTimeout);
    connections[hostId] = conn;
    conn.send({ type: 'join', name: myName });
    setStatus('join', 'Connected! Waiting for host to start...');
    setupClientListeners(conn);
  });
}

// ---- Data Handlers ----
function handleHostConnection(conn) {
  conn.on('data', data => {
    if (data.type === 'join') {
      conn.metadata = { name: data.name || 'Anonymous' };
      connections[conn.peer] = conn;
      systemChat(`${conn.metadata.name} joined the table.`);
      
      const names = [myName, ...Object.values(connections).map(c => c.metadata.name)];
      updateWaitingList(names);
      broadcastAll({ type: 'lobby_update', names });
    } else if (data.type === 'chat') {
      const author = getPlayerNameByPeerId(conn.peer);
      broadcastAll({ type: 'chat', author, msg: data.msg });
      addChat(author, data.msg);
    } else if (data.type === 'action') {
      handlePlayerAction(conn.peer, data);
    }
  });

  conn.on('close', () => {
    const pName = getPlayerNameByPeerId(conn.peer);
    delete connections[conn.peer];
    systemChat(`${pName} left the game.`);
    const names = [myName, ...Object.values(connections).map(c => c.metadata.name)];
    updateWaitingList(names);
    broadcastAll({ type: 'lobby_update', names });
  });
}

function setupClientListeners(conn) {
  conn.on('data', data => {
    if (data.type === 'lobby_update') {
      updateWaitingList(data.names);
    } else if (data.type === 'chat') {
      addChat(data.author, data.msg);
    } else if (data.type === 'game_start') {
      myPlayerId = data.yourId;
      startGameUI(data.state);
    } else if (data.type === 'game_update') {
      gameState = data.state;
      renderGame();
    }
  });

  conn.on('close', () => {
    systemChat('The host closed the connection.');
    // FIXED: Removed location.reload() to prevent unwanted page reloads
    // Instead, just show a message
  });
}

// ---- Utility & Game Logic Hooks ----
function setStatus(tab, msg) {
  // FIXED: Corrected selector to match HTML IDs (host-status, join-status)
  const el = document.getElementById(`${tab}-status`);
  if (el) el.textContent = msg;
}

function updateWaitingList(names) {
  // FIXED: Changed from 'waiting-list' to 'waiting-players' (matches HTML ID)
  const list = document.getElementById('waiting-players');
  if (!list) return;
  
  // FIXED: Create proper HTML structure instead of trying to use <li> in a div
  list.innerHTML = '';
  const namesHtml = names.map(n => `<div style="padding: 4px 0; border-bottom: 1px solid rgba(201,168,76,0.1);">${escHtml(n)}</div>`).join('');
  list.innerHTML = namesHtml;
  
  if (isHost && names.length >= 1) {
    document.getElementById('start-game-btn')?.classList.remove('hidden');
  }
}

// FIXED: Added missing function that's called from HTML
function startGameAsHost() {
  hostStartGame();
}

// FIXED: Added missing copyCode function
function copyCode() {
  const codeText = document.getElementById('room-code-text');
  if (codeText) {
    const code = codeText.textContent;
    navigator.clipboard.writeText(code).then(() => {
      systemChat('Room code copied to clipboard!');
    });
  }
}

function getPlayerNameByPeerId(pid) {
  return (connections[pid] && connections[pid].metadata) ? connections[pid].metadata.name : 'Unknown';
}

function broadcastAll(data) {
  Object.values(connections).forEach(conn => {
    if (conn && conn.open) conn.send(data);
  });
}

// ============================================================
// CORE POKER ENGINE
// ============================================================

const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function createDeck() {
  let deck = [];
  for (let s of SUITS) {
    for (let r of RANKS) deck.push({ rank: r, suit: s });
  }
  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function initGameState() {
  const startChips = parseInt(document.getElementById('starting-chips')?.value || 1000);
  const players = [];
  players.push({ name: myName, chips: startChips, hole: [], bet: 0, folded: false, allIn: false, peerId: 'host' });
  
  Object.values(connections).forEach(conn => {
    players.push({ 
      name: conn.metadata?.name || 'Player', 
      chips: startChips, 
      hole: [], 
      bet: 0, 
      folded: false, 
      allIn: false, 
      peerId: conn.peer 
    });
  });

  return {
    players,
    deck: createDeck(),
    community: [],
    pot: 0,
    stage: 'preflop',
    dealerIdx: 0,
    turnIdx: 0,
    currentBet: 20,
    lastRaiser: -1,
    smallBlind: 10,
    bigBlind: 20
  };
}

function startRound() {
  gameState.deck = createDeck();
  gameState.community = [];
  gameState.pot = 0;
  gameState.stage = 'preflop';
  gameState.currentBet = gameState.bigBlind;
  
  gameState.players.forEach(p => {
    p.hole = [gameState.deck.pop(), gameState.deck.pop()];
    p.bet = 0;
    p.folded = (p.chips <= 0);
    p.allIn = false;
  });

  let sbIdx = (gameState.dealerIdx + 1) % gameState.players.length;
  let bbIdx = (gameState.dealerIdx + 2) % gameState.players.length;
  
  postBlind(sbIdx, gameState.smallBlind);
  postBlind(bbIdx, gameState.bigBlind);

  gameState.turnIdx = (bbIdx + 1) % gameState.players.length;
  gameState.lastRaiser = bbIdx;

  if (isHost) { renderGame(); syncGame(); }
}

function postBlind(idx, amt) {
  const p = gameState.players[idx];
  const actual = Math.min(p.chips, amt);
  p.chips -= actual;
  p.bet = actual;
  gameState.pot += actual;
  if (p.chips === 0) p.allIn = true;
}

function hostStartGame() {
  if (!isHost) return;
  gameState = initGameState();
  startRound();
  document.getElementById('lobby-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');

  Object.values(connections).forEach((conn, idx) => {
    conn.send({ type: 'game_start', yourId: idx + 1, state: gameState });
  });
}

function startGameUI(state) {
  gameState = state;
  document.getElementById('lobby-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');
  renderGame();
}

function syncGame() { broadcastAll({ type: 'game_update', state: gameState }); }

function playerAction(type) {
  if (gameState.turnIdx !== myPlayerId) return;
  let val = 0;
  if (type === 'raise') {
    val = parseInt(document.getElementById('raise-slider').value);
    closeRaise();
  }
  if (isHost) {
    processAction(myPlayerId, type, val);
  } else {
    const hostConn = Object.values(connections)[0];
    if (hostConn) hostConn.send({ type: 'action', action: type, value: val });
  }
}

function handlePlayerAction(peerId, data) {
  const idx = gameState.players.findIndex(p => p.peerId === peerId);
  if (idx !== -1 && idx === gameState.turnIdx) {
    processAction(idx, data.action, data.value);
  }
}

function processAction(pIdx, type, value) {
  const p = gameState.players[pIdx];
  const toCall = gameState.currentBet - p.bet;

  if (type === 'fold') {
    p.folded = true;
    systemChat(`${p.name} folds.`);
  } else if (type === 'check') {
    systemChat(`${p.name} checks.`);
  } else if (type === 'call') {
    const amt = Math.min(p.chips, toCall);
    p.chips -= amt; p.bet += amt; gameState.pot += amt;
    if (p.chips === 0) p.allIn = true;
    systemChat(`${p.name} calls.`);
  } else if (type === 'raise' || type === 'allin') {
    let amt = (type === 'allin') ? p.chips : value - p.bet;
    p.chips -= amt; p.bet += amt; gameState.pot += amt;
    if (p.bet > gameState.currentBet) {
      gameState.currentBet = p.bet;
      gameState.lastRaiser = pIdx;
    }
    if (p.chips === 0) p.allIn = true;
    systemChat(`${p.name} ${type === 'allin' ? 'is All-In' : 'raises to ' + p.bet}.`);
  }
  nextTurn();
}

function nextTurn() {
  let nextIdx = (gameState.turnIdx + 1) % gameState.players.length;
  let loops = 0;
  while ((gameState.players[nextIdx].folded || gameState.players[nextIdx].allIn) && loops < gameState.players.length) {
    nextIdx = (nextIdx + 1) % gameState.players.length;
    loops++;
  }
  if (nextIdx === gameState.lastRaiser || loops >= gameState.players.length - 1) {
    advanceStage();
  } else {
    gameState.turnIdx = nextIdx;
  }
  renderGame();
  syncGame();
}

function advanceStage() {
  gameState.players.forEach(p => p.bet = 0);
  gameState.currentBet = 0;
  gameState.lastRaiser = -1;
  if (gameState.stage === 'preflop') {
    gameState.stage = 'flop';
    gameState.community.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
  } else if (gameState.stage === 'flop') {
    gameState.stage = 'turn';
    gameState.community.push(gameState.deck.pop());
  } else if (gameState.stage === 'turn') {
    gameState.stage = 'river';
    gameState.community.push(gameState.deck.pop());
  } else {
    showdown();
    return;
  }
  let firstIdx = (gameState.dealerIdx + 1) % gameState.players.length;
  while (gameState.players[firstIdx].folded || gameState.players[firstIdx].allIn) {
    firstIdx = (firstIdx + 1) % gameState.players.length;
  }
  gameState.turnIdx = firstIdx;
  gameState.lastRaiser = firstIdx;
}

function showdown() {
  systemChat("Showdown!");
  const winners = gameState.players.filter(p => !p.folded);
  if (winners.length > 0) {
    const winAmt = Math.floor(gameState.pot / winners.length);
    winners.forEach(w => w.chips += winAmt);
  }
  gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
  setTimeout(() => startRound(), 4000);
}

// ---- Rendering ----
function renderGame() {
  if (!gameState) return;
  const commDiv = document.getElementById('community-cards');
  if (commDiv) {
    commDiv.innerHTML = '';
    gameState.community.forEach(c => commDiv.appendChild(createCardUI(c)));
  }
  document.getElementById('pot-amount').textContent = gameState.pot;

  // FIXED: Use opponent-seats container instead of non-existent players-container
  const container = document.getElementById('opponent-seats');
  if (container) {
    container.innerHTML = '';
    gameState.players.forEach((p, i) => {
      if (i === myPlayerId) return; // Skip rendering myself here
      
      const pDiv = document.createElement('div');
      pDiv.className = `opponent-seat ${gameState.turnIdx === i ? 'active' : ''} ${p.folded ? 'folded' : ''}`;
      const angle = (i / gameState.players.length) * Math.PI * 2;
      const x = 50 + 40 * Math.cos(angle);
      const y = 50 + 35 * Math.sin(angle);
      pDiv.style.left = `${x}%`; 
      pDiv.style.top = `${y}%`;

      let cardsHtml = '';
      if (gameState.stage === 'showdown' || !p.folded) {
        if (gameState.stage === 'showdown') {
          p.hole.forEach(c => cardsHtml += createCardUI(c).outerHTML);
        } else {
          cardsHtml = `<div class="card back"></div><div class="card back"></div>`;
        }
      }

      pDiv.innerHTML = `
        <div class="opp-avatar ${gameState.turnIdx === i ? 'active-player' : ''} ${p.folded ? 'folded' : ''}">👤</div>
        <div class="opp-name">${escHtml(p.name)}</div>
        <div class="opp-chips">$${p.chips}</div>
        <div class="opp-hole-cards">${cardsHtml}</div>
        ${p.bet > 0 ? `<div class="opp-bet">Bet: $${p.bet}</div>` : ''}
        ${gameState.dealerIdx === i ? '<div class="dealer-marker">D</div>' : ''}
      `;
      container.appendChild(pDiv);
    });
  }

  // Update my player info
  const myInfo = gameState.players[myPlayerId];
  if (myInfo) {
    document.getElementById('my-name-label').textContent = myName;
    document.getElementById('my-chips-label').textContent = myInfo.chips;
    
    const myHoleCardsDiv = document.getElementById('my-hole-cards');
    if (myHoleCardsDiv) {
      myHoleCardsDiv.innerHTML = '';
      myInfo.hole.forEach(c => myHoleCardsDiv.appendChild(createCardUI(c)));
    }
    
    if (gameState.dealerIdx === myPlayerId) {
      document.getElementById('my-dealer-btn')?.classList.remove('hidden');
    } else {
      document.getElementById('my-dealer-btn')?.classList.add('hidden');
    }
  }

  // FIXED: Changed from 'controls-panel' to 'action-panel' (matches HTML ID)
  const isMyTurn = (gameState.turnIdx === myPlayerId && !gameState.players[myPlayerId].folded);
  document.getElementById('action-panel')?.classList.toggle('hidden', !isMyTurn);
  
  if (isMyTurn) {
    const me = gameState.players[myPlayerId];
    const toCall = gameState.currentBet - me.bet;
    const callLabel = document.getElementById('call-amount-label');
    if (callLabel) callLabel.textContent = toCall > 0 ? `Call $${toCall}` : 'Check';
    document.getElementById('btn-check')?.classList.toggle('hidden', toCall > 0);
    document.getElementById('btn-call')?.classList.toggle('hidden', toCall <= 0);
    const slider = document.getElementById('raise-slider');
    if (slider) {
      slider.min = gameState.currentBet + 20;
      slider.max = me.chips + me.bet;
      slider.value = slider.min;
      updateRaiseDisplay(slider.value);
    }
  }
}

function createCardUI(card) {
  const div = document.createElement('div');
  const isRed = (card.suit === 'h' || card.suit === 'd');
  div.className = `card ${isRed ? 'red' : 'black'}`;
  const suitSymbols = { s: '♠', h: '♥', d: '♦', c: '♣' };
  div.innerHTML = `<div class="card-rank">${card.rank}</div><div class="card-suit">${suitSymbols[card.suit]}</div>`;
  return div;
}

function openRaise() { document.getElementById('raise-panel')?.classList.remove('hidden'); }
function closeRaise() { document.getElementById('raise-panel')?.classList.add('hidden'); }
function updateRaiseDisplay(val) { 
  const display = document.getElementById('raise-display');
  if (display) display.textContent = val; 
}

// ---- Chat ----
function sendChat() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  if (isHost) {
    broadcastAll({ type: 'chat', author: myName, msg });
    addChat(myName, msg);
  } else {
    const hostConn = Object.values(connections)[0];
    if (hostConn) { hostConn.send({ type: 'chat', msg }); addChat(myName, msg); }
  }
}

function addChat(author, msg) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="chat-author">${escHtml(author)}:</span> ${escHtml(msg)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function systemChat(msg) {
  const log = document.getElementById('chat-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = msg;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function escHtml(str) {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML;
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('chat-input')?.addEventListener('keypress', e => {
      if (e.key === 'Enter') sendChat();
    });
});
