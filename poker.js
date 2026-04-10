// ============================================================
// ROYAL HOLD'EM — Texas Hold'em Multiplayer (PeerJS/WebRTC)
// ============================================================

// ---- Globals ----
let peer = null;
let myPeerId = null;
let myName = '';
let isHost = false;
let roomCode = '';
let connections = {};       // peerId -> DataConnection  (host only)
let hostConn = null;        // connection to host         (client only)
let gameState = null;
let myPlayerId = null;      // seat index (0 = host)
let pendingPlayers = [];    // [{peerId, name, seatIdx}]  (host pre-game)

// ============================================================
// SHORT 6-CHAR ROOM CODE
// PeerJS allows any string as the peer ID, so the host
// registers using the short code directly. Much friendlier
// than the default UUID.
// ============================================================
function generateShortCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ---- Tab switching ----
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 && tab === 'host') || (i === 1 && tab === 'join'));
  });
  document.getElementById('tab-host').classList.toggle('active', tab === 'host');
  document.getElementById('tab-join').classList.toggle('active', tab === 'join');
}

function setStatus(tab, msg) {
  const el = document.getElementById(tab + '-status');
  if (el) el.textContent = msg;
}

function copyCode() {
  navigator.clipboard.writeText(roomCode).catch(() => {});
  const btn = document.querySelector('.copy-btn');
  if (!btn) return;
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 1500);
}

// ============================================================
// HOST — creates the table, uses short code as PeerJS ID
// ============================================================
function hostGame() {
  const name = (document.getElementById('host-name').value || '').trim();
  if (!name) { setStatus('host', 'Please enter your name.'); return; }
  myName = name;
  isHost = true;
  myPlayerId = 0;

  const code = generateShortCode();
  roomCode = code;
  setStatus('host', 'Setting up table…');

  peer = new Peer(code, {
    host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 0,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
  });

  peer.on('open', id => {
    myPeerId = id;
    document.getElementById('room-code-text').textContent = code;
    document.getElementById('room-code-display').classList.remove('hidden');
    setStatus('host', '');
    updateWaitingList([name]);
  });

  peer.on('connection', conn => {
    conn.on('open', () => {
      connections[conn.peer] = conn;
      setupHostConnHandlers(conn);
    });
    conn.on('error', e => console.error('conn error', e));
  });

  peer.on('error', e => {
    if (e.type === 'unavailable-id') {
      // Short code collision — try another
      setStatus('host', 'Code taken, generating a new one…');
      peer.destroy();
      setTimeout(hostGame, 400);
    } else {
      setStatus('host', 'Error: ' + e.type);
    }
  });
}

function setupHostConnHandlers(conn) {
  conn.on('data', data => {
    switch (data.type) {
      case 'join_request': {
        if (gameState && gameState.started) {
          conn.send({ type: 'join_denied', reason: 'Game already in progress.' });
          return;
        }
        const seatIdx = pendingPlayers.length + 1;
        pendingPlayers.push({ peerId: conn.peer, name: data.name, seatIdx });
        const allPlayers = buildLobbyList();
        conn.send({ type: 'join_ack', seatIdx, players: allPlayers });
        broadcastAll({ type: 'lobby_update', players: allPlayers });
        updateWaitingList(allPlayers.map(p => p.name));
        document.getElementById('start-game-btn').classList.remove('hidden');
        break;
      }
      case 'player_action':
        handlePlayerAction(conn.peer, data);
        break;
      case 'chat': {
        const author = getNameByPeerId(conn.peer);
        broadcastAll({ type: 'chat', author, msg: data.msg });
        addChat(author, data.msg);
        break;
      }
    }
  });

  conn.on('close', () => {
    const name = getNameByPeerId(conn.peer);
    delete connections[conn.peer];
    pendingPlayers = pendingPlayers.filter(p => p.peerId !== conn.peer);
    systemChat(`${name} left the table.`);
    updateWaitingList(buildLobbyList().map(p => p.name));
  });
}

function buildLobbyList() {
  return [
    { name: myName, seatIdx: 0 },
    ...pendingPlayers.map(p => ({ name: p.name, seatIdx: p.seatIdx }))
  ];
}

function getNameByPeerId(pid) {
  const p = pendingPlayers.find(x => x.peerId === pid);
  return p ? p.name : '?';
}

function broadcastAll(msg) {
  Object.values(connections).forEach(c => { if (c && c.open) c.send(msg); });
}

function updateWaitingList(names) {
  const el = document.getElementById('waiting-players');
  if (!el) return;
  el.innerHTML = `<b>${names.length}</b> player${names.length !== 1 ? 's' : ''}: ${names.join(', ')}`;
}

// ============================================================
// CLIENT — joins using the short code
// ============================================================
function joinGame() {
  const name = (document.getElementById('join-name').value || '').trim();
  const code = (document.getElementById('join-code').value || '').trim().toUpperCase();
  if (!name) { setStatus('join', 'Please enter your name.'); return; }
  if (!code) { setStatus('join', 'Please enter a room code.'); return; }
  myName = name;
  isHost = false;
  roomCode = code;

  setStatus('join', 'Connecting…');

  peer = new Peer(undefined, {
    host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 0,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
  });

  peer.on('open', id => {
    myPeerId = id;
    const conn = peer.connect(code, { reliable: true });
    hostConn = conn;

    const timeout = setTimeout(() => {
      if (!conn.open) setStatus('join', 'Could not reach that table. Double-check the code.');
    }, 8000);

    conn.on('open', () => {
      clearTimeout(timeout);
      conn.send({ type: 'join_request', name });
      setupClientConnHandlers(conn);
    });

    conn.on('error', e => {
      clearTimeout(timeout);
      setStatus('join', 'Connection failed: ' + e.type);
    });
  });

  peer.on('error', e => {
    if (e.type === 'peer-unavailable') {
      setStatus('join', 'Room not found. Check the code and try again.');
    } else {
      setStatus('join', 'Error: ' + e.type);
    }
  });
}

function setupClientConnHandlers(conn) {
  conn.on('data', data => {
    switch (data.type) {
      case 'join_ack':
        myPlayerId = data.seatIdx;
        updateWaitingList(data.players.map(p => p.name));
        setStatus('join', `Joined as seat ${data.seatIdx + 1}. Waiting for host to start…`);
        break;
      case 'join_denied':
        setStatus('join', 'Denied: ' + data.reason);
        break;
      case 'lobby_update':
        updateWaitingList(data.players.map(p => p.name));
        break;
      case 'game_start':
        // Host is starting — switch to game screen immediately
        gameState = data.state;
        showGameScreen();
        renderGame();
        systemChat('Game started! Good luck 🃏');
        break;
      case 'state_update':
        gameState = data.state;
        renderGame();
        break;
      case 'chat':
        addChat(data.author, data.msg);
        break;
      case 'system':
        systemChat(data.msg);
        break;
    }
  });

  conn.on('close', () => systemChat('Connection to host lost.'));
}

// ============================================================
// GAME ENGINE — host drives all state
// ============================================================

const SUITS = ['♠', '♥', '♣', '♦'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Called from HTML "Start Game" button
function startGameAsHost() {
  if (pendingPlayers.length < 1) { alert('Need at least 1 other player to start.'); return; }

  const [sb, bb] = document.getElementById('blind-level').value.split(',').map(Number);
  const startChips = parseInt(document.getElementById('starting-chips').value);

  const allPlayers = [
    { name: myName, peerId: myPeerId },
    ...pendingPlayers.map(p => ({ name: p.name, peerId: p.peerId }))
  ];

  gameState = {
    started: true,
    players: allPlayers.map((p, i) => ({
      id: i, name: p.name, peerId: p.peerId,
      chips: startChips, bet: 0, totalBet: 0,
      folded: false, allIn: false, holeCards: []
    })),
    deck: [],
    communityCards: [],
    pot: 0,
    dealerIdx: 0,
    activeIdx: -1,
    phase: 'waiting',
    sb, bb,
    currentBet: 0,
    minRaise: bb,
    actionCount: 0,
    handNum: 0,
    resultMessage: ''
  };

  // Tell clients the game is starting (no hole cards yet)
  broadcastAll({ type: 'game_start', state: blankHoleState() });

  showGameScreen();
  startNewHand();
}

function startNewHand() {
  const gs = gameState;
  gs.handNum++;
  gs.deck = makeDeck();
  gs.communityCards = [];
  gs.pot = 0;
  gs.currentBet = 0;
  gs.minRaise = gs.bb;
  gs.actionCount = 0;
  gs.resultMessage = '';

  gs.players.forEach(p => {
    p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false; p.holeCards = [];
  });

  // Rotate dealer
  if (gs.handNum > 1) gs.dealerIdx = nextSeat(gs.dealerIdx, gs);

  // Deal hole cards
  for (let round = 0; round < 2; round++) {
    gs.players.forEach(p => p.holeCards.push(gs.deck.pop()));
  }

  // Post blinds
  const sbIdx = nextSeat(gs.dealerIdx, gs);
  const bbIdx = nextSeat(sbIdx, gs);
  forceBet(sbIdx, gs.sb);
  forceBet(bbIdx, gs.bb);
  gs.currentBet = gs.bb;

  gs.phase = 'preflop';
  gs.activeIdx = nextSeat(bbIdx, gs);

  pushStateToAll();
  renderGame();
  systemChat(`Hand #${gs.handNum}  —  Dealer: ${gs.players[gs.dealerIdx].name}`);
}

function nextSeat(fromIdx, gs) {
  const n = gs.players.length;
  let idx = (fromIdx + 1) % n;
  for (let tries = 0; tries < n; tries++) {
    if (!gs.players[idx].folded && gs.players[idx].chips > 0) return idx;
    idx = (idx + 1) % n;
  }
  return (fromIdx + 1) % n;
}

function forceBet(idx, amount) {
  const p = gameState.players[idx];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual; p.bet += actual; p.totalBet += actual;
  gameState.pot += actual;
  if (p.chips === 0) p.allIn = true;
}

// ---- Action handling ----
function handlePlayerAction(fromPeerId, data) {
  const gs = gameState;
  const acting = gs.players[gs.activeIdx];
  if (!acting) return;
  // Security: verify it's actually this player's turn
  if (acting.peerId !== fromPeerId) return;
  applyAction(gs.activeIdx, data.action, data.amount || 0);
}

function applyAction(pIdx, action, amount) {
  const gs = gameState;
  const p = gs.players[pIdx];

  switch (action) {
    case 'fold':
      p.folded = true;
      systemChat(`${p.name} folds.`);
      break;

    case 'check':
      systemChat(`${p.name} checks.`);
      break;

    case 'call': {
      const toCall = Math.min(gs.currentBet - p.bet, p.chips);
      p.chips -= toCall; p.bet += toCall; p.totalBet += toCall; gs.pot += toCall;
      if (p.chips === 0) p.allIn = true;
      systemChat(`${p.name} calls ${toCall}.`);
      break;
    }

    case 'raise': {
      const raiseBy = Math.max(amount, gs.minRaise);
      const newBetTotal = gs.currentBet + raiseBy;
      const toAdd = Math.min(newBetTotal - p.bet, p.chips);
      p.chips -= toAdd; p.bet += toAdd; p.totalBet += toAdd; gs.pot += toAdd;
      if (p.bet > gs.currentBet) {
        gs.minRaise = Math.max(gs.bb, p.bet - gs.currentBet);
        gs.currentBet = p.bet;
        gs.actionCount = 0;
      }
      if (p.chips === 0) p.allIn = true;
      systemChat(`${p.name} raises to ${p.bet}.`);
      break;
    }

    case 'allin': {
      const aiAmt = p.chips;
      const newBet = p.bet + aiAmt;
      if (newBet > gs.currentBet) {
        gs.minRaise = Math.max(gs.bb, newBet - gs.currentBet);
        gs.currentBet = newBet;
        gs.actionCount = 0;
      }
      gs.pot += aiAmt; p.bet = newBet; p.totalBet += aiAmt;
      p.chips = 0; p.allIn = true;
      systemChat(`${p.name} goes ALL IN for ${aiAmt}!`);
      break;
    }
  }

  gs.actionCount++;
  advanceAction();
}

function advanceAction() {
  const gs = gameState;
  const notFolded = gs.players.filter(p => !p.folded);
  if (notFolded.length === 1) { awardPot(notFolded); return; }

  const canAct = notFolded.filter(p => !p.allIn && p.chips > 0);
  const allSettled = canAct.every(p => p.bet >= gs.currentBet);

  if (allSettled && gs.actionCount >= Math.max(1, canAct.length)) {
    advancePhase();
    return;
  }

  // Find next player who can act
  const n = gs.players.length;
  let next = (gs.activeIdx + 1) % n;
  for (let tries = 0; tries < n; tries++) {
    const p = gs.players[next];
    if (!p.folded && !p.allIn && p.chips > 0) break;
    next = (next + 1) % n;
    tries++;
  }
  gs.activeIdx = next;

  pushStateToAll();
  renderGame();
}

function advancePhase() {
  const gs = gameState;
  gs.players.forEach(p => { p.bet = 0; });
  gs.currentBet = 0;
  gs.actionCount = 0;
  gs.minRaise = gs.bb;

  const next = { preflop:'flop', flop:'turn', turn:'river', river:'showdown' };
  gs.phase = next[gs.phase] || 'showdown';

  if (gs.phase === 'flop') {
    gs.communityCards.push(gs.deck.pop(), gs.deck.pop(), gs.deck.pop());
    systemChat('— Flop —');
  } else if (gs.phase === 'turn') {
    gs.communityCards.push(gs.deck.pop());
    systemChat('— Turn —');
  } else if (gs.phase === 'river') {
    gs.communityCards.push(gs.deck.pop());
    systemChat('— River —');
  } else {
    doShowdown(); return;
  }

  // First to act after dealer
  const n = gs.players.length;
  let next2 = (gs.dealerIdx + 1) % n;
  for (let tries = 0; tries < n; tries++) {
    if (!gs.players[next2].folded && !gs.players[next2].allIn) break;
    next2 = (next2 + 1) % n;
  }
  gs.activeIdx = next2;

  pushStateToAll();
  renderGame();
}

// ============================================================
// HAND EVALUATION
// ============================================================
function evalBestHand(cards) {
  const combos = [];
  const pick = (start, chosen) => {
    if (chosen.length === 5) { combos.push([...chosen]); return; }
    for (let i = start; i < cards.length; i++) { chosen.push(cards[i]); pick(i+1, chosen); chosen.pop(); }
  };
  pick(0, []);
  let best = null;
  for (const c of combos) {
    const s = score5(c);
    if (!best || cmpScore(s, best.score) > 0) best = { score: s };
  }
  return best;
}

function score5(cards) {
  const vals = cards.map(c => RANK_VAL[c.r]).sort((a,b) => b-a);
  const suits = cards.map(c => c.s);
  const flush = suits.every(s => s === suits[0]);
  const str = checkStraight(vals);
  const freq = {};
  vals.forEach(v => freq[v] = (freq[v]||0)+1);
  const groups = Object.entries(freq).map(([v,c]) => [+v,+c]).sort((a,b) => b[1]-a[1] || b[0]-a[0]);
  const [g0, g1] = groups;

  if (flush && str)                   return [8, str];
  if (g0[1] === 4)                    return [7, g0[0], g1[0]];
  if (g0[1] === 3 && g1 && g1[1]===2) return [6, g0[0], g1[0]];
  if (flush)                          return [5, ...vals];
  if (str)                            return [4, str];
  if (g0[1] === 3)                    return [3, g0[0], ...groups.slice(1).map(g=>g[0])];
  if (g0[1] === 2 && g1 && g1[1]===2) return [2, g0[0], g1[0], groups[2] ? groups[2][0] : 0];
  if (g0[1] === 2)                    return [1, g0[0], ...groups.slice(1).map(g=>g[0])];
  return [0, ...vals];
}

function checkStraight(sv) {
  if (sv[0]-sv[4] === 4 && new Set(sv).size === 5) return sv[0];
  if (JSON.stringify(sv) === JSON.stringify([14,5,4,3,2])) return 5;
  return 0;
}

function cmpScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i]||0) - (b[i]||0);
    if (d) return d;
  }
  return 0;
}

const HAND_NAMES = ['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush'];

function doShowdown() {
  const gs = gameState;
  const contenders = gs.players.filter(p => !p.folded);
  const ranked = contenders.map(p => ({
    player: p,
    score: evalBestHand([...p.holeCards, ...gs.communityCards]).score
  })).sort((a,b) => cmpScore(b.score, a.score));

  const topScore = ranked[0].score;
  const winners = ranked.filter(r => cmpScore(r.score, topScore) === 0);
  const share = Math.floor(gs.pot / winners.length);
  winners.forEach(w => w.player.chips += share);

  gs.resultMessage = winners.map(w => `${w.player.name} (${HAND_NAMES[w.score[0]]})`).join(' & ') + ` — wins ${gs.pot}`;
  gs.phase = 'showdown';

  pushStateToAll();
  renderGame();
  systemChat('🏆 ' + gs.resultMessage);

  setTimeout(() => {
    gs.players = gs.players.filter(p => p.chips > 0);
    if (gs.players.length < 2) {
      systemChat(`🎉 ${gs.players[0]?.name || 'Someone'} wins the game!`);
    } else {
      startNewHand();
    }
  }, 4500);
}

function awardPot(winners) {
  const gs = gameState;
  const share = Math.floor(gs.pot / winners.length);
  winners.forEach(w => w.chips += share);
  gs.resultMessage = `${winners.map(w => w.name).join(' & ')} wins ${gs.pot}`;
  gs.phase = 'showdown';
  pushStateToAll();
  renderGame();
  systemChat('🏆 ' + gs.resultMessage);
  setTimeout(() => {
    gs.players = gs.players.filter(p => p.chips > 0);
    if (gs.players.length >= 2) startNewHand();
    else systemChat(`🎉 ${gs.players[0]?.name} wins the game!`);
  }, 3500);
}

// ============================================================
// STATE SYNC
// ============================================================
function blankHoleState() {
  return { ...gameState, players: gameState.players.map(p => ({ ...p, holeCards: [] })) };
}

function stateFor(targetPeerId) {
  const gs = gameState;
  return {
    ...gs,
    players: gs.players.map(p => ({
      ...p,
      holeCards: (p.peerId === targetPeerId || gs.phase === 'showdown') ? p.holeCards : []
    }))
  };
}

function pushStateToAll() {
  pendingPlayers.forEach(pp => {
    const conn = connections[pp.peerId];
    if (conn && conn.open) {
      conn.send({ type: 'state_update', state: stateFor(pp.peerId) });
    }
  });
}

// ============================================================
// SHOW GAME SCREEN
// ============================================================
function showGameScreen() {
  document.getElementById('lobby-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');
  if (gameState) {
    document.getElementById('blinds-label').textContent = `Blinds ${gameState.sb}/${gameState.bb}`;
  }
}

// ============================================================
// RENDERING
// ============================================================
function renderGame() {
  if (!gameState) return;
  const gs = gameState;
  const me = gs.players[myPlayerId];

  const phaseNames = { waiting:'Waiting', preflop:'Pre-Flop', flop:'Flop', turn:'Turn', river:'River', showdown:'Showdown' };
  document.getElementById('game-phase-label').textContent = phaseNames[gs.phase] || gs.phase;
  document.getElementById('pot-amount').textContent = gs.pot;
  document.getElementById('blinds-label').textContent = `Blinds ${gs.sb}/${gs.bb}`;

  // Community cards
  const commEl = document.getElementById('community-cards');
  commEl.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    commEl.appendChild(gs.communityCards[i] ? makeCardEl(gs.communityCards[i]) : makePlaceholder());
  }

  // Result overlay
  const resultEl = document.getElementById('round-result');
  if (gs.resultMessage && gs.phase === 'showdown') {
    resultEl.textContent = gs.resultMessage;
    resultEl.classList.remove('hidden');
  } else {
    resultEl.classList.add('hidden');
  }

  // My hole cards
  const myHoleEl = document.getElementById('my-hole-cards');
  myHoleEl.innerHTML = '';
  if (me && me.holeCards && me.holeCards.length) {
    me.holeCards.forEach(c => myHoleEl.appendChild(makeCardEl(c)));
  }

  // My info bar
  if (me) {
    document.getElementById('my-name-label').textContent = me.name;
    document.getElementById('my-chips-label').textContent = me.chips;
    document.getElementById('player-info-bar').classList.toggle('active-player', gs.activeIdx === myPlayerId);
    document.getElementById('my-dealer-btn').classList.toggle('hidden', gs.dealerIdx !== myPlayerId);
    const tag = document.getElementById('player-status-tag');
    tag.textContent = me.folded ? 'FOLDED' : me.allIn ? 'ALL IN' : me.bet > 0 ? `Bet: ${me.bet}` : '';
  }

  renderOpponents(gs);

  // Action panel
  const myTurn = gs.activeIdx === myPlayerId
    && gs.phase !== 'showdown' && gs.phase !== 'waiting'
    && me && !me.folded && !me.allIn;
  document.getElementById('action-panel').classList.toggle('hidden', !myTurn);

  if (myTurn && me) {
    const toCall = Math.max(0, gs.currentBet - me.bet);
    document.getElementById('btn-check').disabled = toCall > 0;
    document.getElementById('btn-call').disabled = toCall <= 0;
    document.getElementById('btn-call').textContent = toCall > 0 ? `Call ${toCall}` : 'Call';
    document.getElementById('call-amount-label').textContent = toCall > 0 ? `To call: ${toCall}` : 'No bet yet';

    const slider = document.getElementById('raise-slider');
    const minR = gs.currentBet + gs.minRaise - me.bet;
    slider.min = Math.max(1, Math.min(minR, me.chips));
    slider.max = me.chips;
    if (+slider.value < +slider.min) slider.value = slider.min;
    updateRaiseDisplay(slider.value);

    document.getElementById('btn-raise').disabled = me.chips <= 0;
    document.getElementById('btn-allin').disabled = me.chips <= 0;
  }
}

const SEAT_POSITIONS = [
  { top: '-72px',    left: '50%',   transform: 'translateX(-50%)' },
  { top: '5%',       right: '-80px', transform: 'none' },
  { bottom: '5%',    right: '-80px', transform: 'none' },
  { bottom: '-72px', left: '30%',   transform: 'none' },
  { bottom: '-72px', right: '30%',  transform: 'none' },
  { top: '5%',       left: '-80px', transform: 'none' },
  { bottom: '5%',    left: '-80px', transform: 'none' },
];

const AVATARS = ['🎩','🃏','🎰','🦊','🐉','🎭','🎪','👑'];

function renderOpponents(gs) {
  const container = document.getElementById('opponent-seats');
  container.innerHTML = '';
  let slot = 0;

  gs.players.forEach((p, i) => {
    if (i === myPlayerId) return;
    const pos = SEAT_POSITIONS[slot % SEAT_POSITIONS.length];
    slot++;

    const seat = document.createElement('div');
    seat.className = 'opponent-seat';
    Object.assign(seat.style, pos);

    const av = document.createElement('div');
    av.className = 'opp-avatar'
      + (gs.activeIdx === i ? ' active-player' : '')
      + (p.folded ? ' folded' : '');
    av.textContent = AVATARS[i % AVATARS.length];

    if (gs.dealerIdx === i) {
      const dm = document.createElement('div');
      dm.className = 'dealer-marker'; dm.textContent = 'D';
      av.appendChild(dm);
    }

    const nm = document.createElement('div'); nm.className = 'opp-name'; nm.textContent = p.name;
    const ch = document.createElement('div'); ch.className = 'opp-chips'; ch.textContent = '₪ ' + p.chips;

    const hc = document.createElement('div');
    hc.className = 'opp-hole-cards';
    if (p.holeCards && p.holeCards.length > 0) {
      const faceDown = gs.phase !== 'showdown' || p.folded;
      p.holeCards.forEach(c => hc.appendChild(makeCardSmEl(c, faceDown)));
    } else if (!p.folded && gs.phase !== 'waiting') {
      hc.appendChild(makeCardSmEl(null, true));
      hc.appendChild(makeCardSmEl(null, true));
    }

    seat.appendChild(av); seat.appendChild(nm); seat.appendChild(ch);
    if (hc.children.length) seat.appendChild(hc);

    if (p.bet > 0 && gs.phase !== 'showdown') {
      const bt = document.createElement('div'); bt.className = 'opp-bet'; bt.textContent = '+ ' + p.bet;
      seat.appendChild(bt);
    }
    if (p.folded) {
      const st = document.createElement('div'); st.className = 'opp-bet';
      st.textContent = 'FOLDED'; st.style.color = '#f87171';
      seat.appendChild(st);
    } else if (p.allIn) {
      const st = document.createElement('div'); st.className = 'opp-bet';
      st.textContent = 'ALL IN'; st.style.color = '#c4b5fd';
      seat.appendChild(st);
    }

    container.appendChild(seat);
  });
}

function makePlaceholder() {
  const ph = document.createElement('div');
  ph.className = 'card card-back';
  ph.style.opacity = '0.18';
  return ph;
}

function makeCardEl(card, faceDown = false) {
  const el = document.createElement('div');
  if (faceDown || !card) { el.className = 'card card-back'; return el; }
  const isRed = card.s === '♥' || card.s === '♦';
  el.className = 'card ' + (isRed ? 'red' : 'black');
  const rank = document.createElement('div'); rank.className = 'card-rank'; rank.textContent = card.r;
  const suit = document.createElement('div'); suit.className = 'card-suit'; suit.textContent = card.s;
  el.appendChild(rank); el.appendChild(suit);
  return el;
}

function makeCardSmEl(card, faceDown = false) {
  const el = makeCardEl(card, faceDown);
  el.classList.add('card-sm');
  return el;
}

// ============================================================
// PLAYER ACTIONS (from UI buttons)
// ============================================================
function playerAction(action) {
  if (!gameState || gameState.activeIdx !== myPlayerId) return;
  const amount = action === 'raise' ? (parseInt(document.getElementById('raise-display').textContent) || 0) : 0;

  if (isHost) {
    applyAction(myPlayerId, action, amount);
  } else {
    if (hostConn && hostConn.open) hostConn.send({ type: 'player_action', action, amount });
  }
  closeRaise();
}

function openRaise()  { document.getElementById('raise-panel').classList.remove('hidden'); }
function closeRaise() { document.getElementById('raise-panel').classList.add('hidden'); }
function updateRaiseDisplay(val) { document.getElementById('raise-display').textContent = val; }

// ============================================================
// CHAT
// ============================================================
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = (input.value || '').trim();
  if (!msg) return;
  input.value = '';
  if (isHost) {
    broadcastAll({ type: 'chat', author: myName, msg });
    addChat(myName, msg);
  } else {
    if (hostConn && hostConn.open) hostConn.send({ type: 'chat', msg });
    addChat(myName, msg);
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
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
