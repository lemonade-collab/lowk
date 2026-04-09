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

// PeerJS Configuration for Stability
const PEER_CONFIG = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  debug: 3 // Set to 3 for detailed logs to help debug connection issues
};

// ---- Tab switching ----
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 && tab === 'host') || (i === 1 && tab === 'join'));
  });
  document.getElementById('tab-host').classList.toggle('active', tab === 'host');
  document.getElementById('tab-join').classList.toggle('active', tab === 'join');
}

// ---- Lobby: Host ----
function hostGame() {
  const name = document.getElementById('host-name').value.trim();
  if (!name) { setStatus('host', 'Please enter your name.'); return; }
  myName = name;
  isHost = true;

  setStatus('host', 'Connecting to signaling server…');
  
  // Initialize Peer
  peer = new Peer(undefined, PEER_CONFIG);

  peer.on('open', id => {
    myPeerId = id;
    roomCode = id;
    document.getElementById('room-code-text').textContent = id;
    document.getElementById('room-code-display').classList.remove('hidden');
    setStatus('host', 'Table created. Waiting for players.');
    updateWaitingList([name]);

    // Host is player 0
    myPlayerId = 0;
  });

  peer.on('connection', conn => {
    handleHostConnection(conn);
  });

  peer.on('error', err => {
    console.error('PeerJS Error:', err.type, err);
    setStatus('host', `Connection Error: ${err.type}. Try again.`);
  });
}

function handleHostConnection(conn) {
  conn.on('open', () => {
    // We expect the first message to be "join"
    conn.on('data', data => {
      if (data.type === 'join') {
        const pName = data.name || 'Unknown';
        connections[conn.peer] = conn;
        systemChat(`${pName} joined the lobby.`);
        
        // Sync lobby names to all
        const playerNames = [myName, ...Object.values(connections).map(c => c.metadata.name)];
        // Note: metadata is set on the client side during peer.connect
        updateWaitingList(playerNames);
        broadcastAll({ type: 'lobby_update', names: playerNames });
      } else if (data.type === 'chat') {
        const author = getPlayerNameByPeerId(conn.peer);
        broadcastAll({ type: 'chat', author, msg: data.msg });
        addChat(author, data.msg);
      } else if (data.type === 'action') {
        handlePlayerAction(conn.peer, data);
      }
    });
  });

  conn.on('close', () => {
    const pName = getPlayerNameByPeerId(conn.peer);
    delete connections[conn.peer];
    systemChat(`${pName} left.`);
    const playerNames = [myName, ...Object.values(connections).map(c => c.metadata.name)];
    updateWaitingList(playerNames);
    broadcastAll({ type: 'lobby_update', names: playerNames });
  });
}

// ---- Lobby: Join ----
function joinGame() {
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim();
  if (!name || !code) { setStatus('join', 'Enter name and room code.'); return; }

  myName = name;
  isHost = false;
  roomCode = code;

  setStatus('join', 'Connecting to server…');
  peer = new Peer(undefined, PEER_CONFIG);

  peer.on('open', id => {
    myPeerId = id;
    setStatus('join', `Connecting to host ${code}…`);
    
    // Connect to host, pass name in metadata for identification
    const conn = peer.connect(code, { metadata: { name: myName } });
    
    conn.on('open', () => {
      connections[code] = conn;
      conn.send({ type: 'join', name: myName });
      setStatus('join', 'Joined! Waiting for host to start…');
    });

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
      systemChat('Host disconnected.');
      location.reload();
    });
  });

  peer.on('error', err => {
    console.error('Join Error:', err);
    setStatus('join', `Failed to connect: ${err.type}`);
  });
}

// ---- UI Helpers ----
function setStatus(tab, msg) {
  // Fix: Use 'status-msg-' prefix to match index.html IDs
  const el = document.getElementById(`status-msg-${tab}`);
  if (el) el.textContent = msg;
}

function updateWaitingList(names) {
  const list = document.getElementById('waiting-list');
  list.innerHTML = '';
  names.forEach(n => {
    const li = document.createElement('li');
    li.textContent = n;
    list.appendChild(li);
  });
  // Show Start button only to host if enough players
  if (isHost) {
    document.getElementById('start-btn-container').classList.remove('hidden');
  }
}

function getPlayerNameByPeerId(pid) {
  const conn = connections[pid];
  return conn && conn.metadata ? conn.metadata.name : 'Unknown';
}

function broadcastAll(data) {
  Object.values(connections).forEach(conn => {
    if (conn.open) conn.send(data);
  });
}

// ============================================================
// GAME LOGIC
// ============================================================

const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function createDeck() {
  let deck = [];
  for (let s of SUITS) {
    for (let r of RANKS) {
      deck.push({ rank: r, suit: s });
    }
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
  const startChips = parseInt(document.getElementById('starting-chips').value);
  const players = [];
  
  // Host
  players.push({ name: myName, chips: startChips, hole: [], bet: 0, folded: false, allIn: false, peerId: 'host' });
  
  // Others
  Object.values(connections).forEach(conn => {
    players.push({ 
      name: conn.metadata.name, 
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
    stage: 'preflop', // preflop, flop, turn, river, showdown
    dealerIdx: 0,
    turnIdx: 0,
    minRaise: 20,
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
  
  // Reset players
  gameState.players.forEach(p => {
    p.hole = [gameState.deck.pop(), gameState.deck.pop()];
    p.bet = 0;
    p.folded = (p.chips <= 0);
    p.allIn = false;
  });

  // Blinds
  let sbIdx = (gameState.dealerIdx + 1) % gameState.players.length;
  let bbIdx = (gameState.dealerIdx + 2) % gameState.players.length;
  
  postBlind(sbIdx, gameState.smallBlind);
  postBlind(bbIdx, gameState.bigBlind);

  gameState.turnIdx = (bbIdx + 1) % gameState.players.length;
  gameState.lastRaiser = bbIdx;

  if (isHost) {
    renderGame();
    syncGame();
  }
}

function postBlind(idx, amt) {
  const p = gameState.players[idx];
  const actual = Math.min(p.chips, amt);
  p.chips -= actual;
  p.bet = actual;
  gameState.pot += actual;
  if (p.chips === 0) p.allIn = true;
}

// ---- UI Interaction ----
function hostStartGame() {
  if (!isHost) return;
  gameState = initGameState();
  startRound();
  
  document.getElementById('lobby-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');

  // Tell everyone to start
  Object.values(connections).forEach((conn, idx) => {
    conn.send({ 
      type: 'game_start', 
      yourId: idx + 1, 
      state: gameState 
    });
  });
}

function startGameUI(state) {
  gameState = state;
  document.getElementById('lobby-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');
  renderGame();
}

function syncGame() {
  broadcastAll({ type: 'game_update', state: gameState });
}

// ---- Game Loop Logic ----
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
    Object.values(connections)[0].send({ type: 'action', action: type, value: val });
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
    p.chips -= amt;
    p.bet += amt;
    gameState.pot += amt;
    if (p.chips === 0) p.allIn = true;
    systemChat(`${p.name} calls.`);
  } else if (type === 'raise' || type === 'allin') {
    let amt = (type === 'allin') ? p.chips : value - p.bet;
    if (amt > p.chips) amt = p.chips;
    
    p.chips -= amt;
    p.bet += amt;
    gameState.pot += amt;
    
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
  // Check if round ended (everyone called or folded)
  let nextIdx = (gameState.turnIdx + 1) % gameState.players.length;
  
  // Skip folded/all-in
  let loops = 0;
  while ((gameState.players[nextIdx].folded || gameState.players[nextIdx].allIn) && loops < gameState.players.length) {
    nextIdx = (nextIdx + 1) % gameState.players.length;
    loops++;
  }

  // End of betting round?
  if (nextIdx === gameState.lastRaiser || loops >= gameState.players.length - 1) {
    advanceStage();
  } else {
    gameState.turnIdx = nextIdx;
  }
  
  renderGame();
  syncGame();
}

function advanceStage() {
  // Clear bets
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

  // First active player after dealer starts
  let firstIdx = (gameState.dealerIdx + 1) % gameState.players.length;
  while (gameState.players[firstIdx].folded || gameState.players[firstIdx].allIn) {
    firstIdx = (firstIdx + 1) % gameState.players.length;
  }
  gameState.turnIdx = firstIdx;
  gameState.lastRaiser = firstIdx;
}

function showdown() {
  systemChat("Showdown!");
  // Simplistic winner: just find first non-folded for now 
  // (Actual poker evaluation requires a library or 200 lines of rank logic)
  const winners = gameState.players.filter(p => !p.folded);
  if (winners.length > 0) {
    const winAmt = Math.floor(gameState.pot / winners.length);
    winners.forEach(w => {
      w.chips += winAmt;
      systemChat(`${w.name} wins ${winAmt} chips!`);
    });
  }

  gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
  
  setTimeout(() => {
    startRound();
  }, 5000);
}

// ---- Rendering ----
function renderGame() {
  if (!gameState) return;

  // Render community
  const commDiv = document.getElementById('community-cards');
  commDiv.innerHTML = '';
  gameState.community.forEach(c => commDiv.appendChild(createCardUI(c)));

  const potEl = document.getElementById('pot-amount');
  potEl.textContent = gameState.pot;

  // Render players
  const container = document.getElementById('players-container');
  container.innerHTML = '';

  gameState.players.forEach((p, i) => {
    const isMe = (i === myPlayerId);
    const pDiv = document.createElement('div');
    pDiv.className = `player-slot ${gameState.turnIdx === i ? 'active' : ''} ${p.folded ? 'folded' : ''}`;
    
    // Position players in a circle (basic)
    const angle = (i / gameState.players.length) * Math.PI * 2;
    const x = 50 + 40 * Math.cos(angle);
    const y = 50 + 35 * Math.sin(angle);
    pDiv.style.left = `${x}%`;
    pDiv.style.top = `${y}%`;

    let cardsHtml = '';
    if (isMe || gameState.stage === 'showdown') {
      p.hole.forEach(c => {
        const card = createCardUI(c);
        cardsHtml += card.outerHTML;
      });
    } else if (!p.folded) {
      cardsHtml = `<div class="card back"></div><div class="card back"></div>`;
    }

    pDiv.innerHTML = `
      <div class="player-info">
        <div class="p-name">${p.name} ${i === gameState.dealerIdx ? '<span class="dealer-btn">D</span>' : ''}</div>
        <div class="p-chips">$${p.chips}</div>
      </div>
      <div class="p-cards">${cardsHtml}</div>
      ${p.bet > 0 ? `<div class="p-bet">Bet: $${p.bet}</div>` : ''}
    `;
    container.appendChild(pDiv);
  });

  // Controls
  const isMyTurn = (gameState.turnIdx === myPlayerId && !gameState.players[myPlayerId].folded);
  document.getElementById('controls-panel').classList.toggle('active', isMyTurn);
  
  if (isMyTurn) {
    const me = gameState.players[myPlayerId];
    const toCall = gameState.currentBet - me.bet;
    document.getElementById('call-amount-label').textContent = toCall > 0 ? `Call $${toCall}` : 'Check';
    document.getElementById('btn-check').classList.toggle('hidden', toCall > 0);
    document.getElementById('btn-call').classList.toggle('hidden', toCall <= 0);
    
    // Raise slider setup
    const slider = document.getElementById('raise-slider');
    slider.min = gameState.currentBet + gameState.bigBlind;
    slider.max = me.chips + me.bet;
    slider.value = slider.min;
    updateRaiseDisplay(slider.value);
  }
}

function createCardUI(card) {
  const div = document.createElement('div');
  const isRed = (card.suit === 'h' || card.suit === 'd');
  div.className = `card ${isRed ? 'red' : ''}`;
  
  const suitSymbols = { s: '♠', h: '♥', d: '♦', c: '♣' };
  div.innerHTML = `
    <div class="card-rank">${card.rank}</div>
    <div class="card-suit">${suitSymbols[card.suit]}</div>
  `;
  return div;
}

function openRaise() {
  document.getElementById('raise-panel').classList.remove('hidden');
}
function closeRaise() {
  document.getElementById('raise-panel').classList.add('hidden');
}
function updateRaiseDisplay(val) {
  document.getElementById('raise-display').textContent = val;
}

// ============================================================
// CHAT
// ============================================================
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  if (isHost) {
    broadcastAll({ type: 'chat', author: myName, msg });
    addChat(myName, msg);
  } else {
    Object.values(connections)[0].send({ type: 'chat', msg });
    addChat(myName, msg); // show immediately for sender
  }
}

function addChat(author, msg) {
  const log = document.getElementById('chat-log');
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

// Handle enter key in chat
document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendChat();
        });
    }
});
