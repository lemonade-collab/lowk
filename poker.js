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
  debug: 3 // Detailed logs for debugging connection issues
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
  
  // Cleanup previous peer if it exists
  if (peer) {
    peer.destroy();
  }

  // Initialize Peer
  peer = new Peer(undefined, PEER_CONFIG);

  peer.on('open', id => {
    myPeerId = id;
    roomCode = id;
    const codeDisplay = document.getElementById('room-code-text');
    if (codeDisplay) codeDisplay.textContent = id;
    
    const displayBox = document.getElementById('room-code-display');
    if (displayBox) displayBox.classList.remove('hidden');
    
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
    if (err.type === 'network') {
      setStatus('host', 'Network error: Lost connection to server. Retrying...');
      // Brief delay before allowing manual retry or auto-reconnecting
      setTimeout(() => {
        if (isHost && !myPeerId) hostGame();
      }, 3000);
    } else {
      setStatus('host', `Connection Error: ${err.type}. Please refresh.`);
    }
  });

  peer.on('disconnected', () => {
    console.log('Peer disconnected from signaling server. Attempting to reconnect...');
    peer.reconnect();
  });
}

function handleHostConnection(conn) {
  conn.on('open', () => {
    conn.on('data', data => {
      if (data.type === 'join') {
        const pName = data.name || 'Unknown';
        connections[conn.peer] = conn;
        // Store name in metadata for easier access
        conn.metadata = { name: pName };
        systemChat(`${pName} joined the lobby.`);
        
        // Sync lobby names to all
        const playerNames = [myName, ...Object.values(connections).map(c => c.metadata.name)];
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
  
  if (peer) peer.destroy();
  peer = new Peer(undefined, PEER_CONFIG);

  peer.on('open', id => {
    myPeerId = id;
    setStatus('join', `Connecting to host ${code}…`);
    
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
      systemChat('Connection to host closed.');
      setTimeout(() => location.reload(), 3000);
    });
  });

  peer.on('error', err => {
    console.error('Join Error:', err.type, err);
    if (err.type === 'peer-not-found') {
      setStatus('join', 'Error: Room code not found. Check the code.');
    } else if (err.type === 'network') {
      setStatus('join', 'Network error. Signaling server unreachable.');
    } else {
      setStatus('join', `Failed to connect: ${err.type}`);
    }
  });
}

// ---- UI Helpers ----
function setStatus(tab, msg) {
  const el = document.getElementById(`status-msg-${tab}`);
  if (el) el.textContent = msg;
}

function updateWaitingList(names) {
  const list = document.getElementById('waiting-list');
  if (!list) return;
  list.innerHTML = '';
  names.forEach(n => {
    const li = document.createElement('li');
    li.textContent = n;
    list.appendChild(li);
  });
  
  if (isHost) {
    const startBtn = document.getElementById('start-btn-container');
    if (startBtn) startBtn.classList.remove('hidden');
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
  const chipsInput = document.getElementById('starting-chips');
  const startChips = chipsInput ? parseInt(chipsInput.value) : 1000;
  const players = [];
  
  players.push({ name: myName, chips: startChips, hole: [], bet: 0, folded: false, allIn: false, peerId: 'host' });
  
  Object.values(connections).forEach(conn => {
    players.push({ 
      name: conn.metadata ? conn.metadata.name : 'Player', 
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

function hostStartGame() {
  if (!isHost) return;
  gameState = initGameState();
  startRound();
  
  document.getElementById('lobby-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');

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

  const commDiv = document.getElementById('community-cards');
  if (commDiv) {
    commDiv.innerHTML = '';
    gameState.community.forEach(c => commDiv.appendChild(createCardUI(c)));
  }

  const potEl = document.getElementById('pot-amount');
  if (potEl) potEl.textContent = gameState.pot;

  const container = document.getElementById('players-container');
  if (container) {
    container.innerHTML = '';
    gameState.players.forEach((p, i) => {
      const isMe = (i === myPlayerId);
      const pDiv = document.createElement('div');
      pDiv.className = `player-slot ${gameState.turnIdx === i ? 'active' : ''} ${p.folded ? 'folded' : ''}`;
      
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
  }

  const isMyTurn = (gameState.turnIdx === myPlayerId && !gameState.players[myPlayerId].folded);
  const controls = document.getElementById('controls-panel');
  if (controls) controls.classList.toggle('active', isMyTurn);
  
  if (isMyTurn) {
    const me = gameState.players[myPlayerId];
    const toCall = gameState.currentBet - me.bet;
    const callLabel = document.getElementById('call-amount-label');
    if (callLabel) callLabel.textContent = toCall > 0 ? `Call $${toCall}` : 'Check';
    
    const checkBtn = document.getElementById('btn-check');
    if (checkBtn) checkBtn.classList.toggle('hidden', toCall > 0);
    
    const callBtn = document.getElementById('btn-call');
    if (callBtn) callBtn.classList.toggle('hidden', toCall <= 0);
    
    const slider = document.getElementById('raise-slider');
    if (slider) {
      slider.min = gameState.currentBet + gameState.bigBlind;
      slider.max = me.chips + me.bet;
      slider.value = slider.min;
      updateRaiseDisplay(slider.value);
    }
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
  const panel = document.getElementById('raise-panel');
  if (panel) panel.classList.remove('hidden');
}
function closeRaise() {
  const panel = document.getElementById('raise-panel');
  if (panel) panel.classList.add('hidden');
}
function updateRaiseDisplay(val) {
  const display = document.getElementById('raise-display');
  if (display) display.textContent = val;
}

// ============================================================
// CHAT
// ============================================================
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
    if (hostConn) {
      hostConn.send({ type: 'chat', msg });
      addChat(myName, msg);
    }
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

// Handle enter key in chat
document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendChat();
        });
    }
});
