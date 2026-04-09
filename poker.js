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

  setStatus('host', 'Connecting…');
  peer = new Peer(undefined, { debug: 0 });

  peer.on('open', id => {
    myPeerId = id;
    roomCode = id;
    document.getElementById('room-code-text').textContent = id;
    document.getElementById('room-code-display').classList.remove('hidden');
    setStatus('host', '');
    updateWaitingList([name]);

    // Host is player 0
    myPlayerId = 0;
  });

  peer.on('connection', conn => {
    conn.on('open', () => {
      connections[conn.peer] = conn;
      conn.on('data', data => handleMessage(conn.peer, data));
      conn.on('close', () => {
        delete connections[conn.peer];
        systemChat(`A player disconnected.`);
        updateWaitingList(getPlayerNames());
      });
    });
    conn.on('error', e => console.error('conn error', e));
  });

  peer.on('error', e => setStatus('host', 'Error: ' + e.message));
}

function getPlayerNames() {
  if (!gameState) {
    // pre-game: just from pending joins
    return pendingPlayers.map(p => p.name);
  }
  return gameState.players.map(p => p.name);
}

let pendingPlayers = []; // [{peerId, name}]

function handleMessage(fromPeerId, data) {
  if (!isHost) {
    handleClientMessage(data);
    return;
  }
  // Host receives messages
  if (data.type === 'join_request') {
    if (gameState && gameState.started) {
      connections[fromPeerId].send({ type: 'join_denied', reason: 'Game already in progress.' });
      return;
    }
    const seatIdx = pendingPlayers.length + 1; // host is 0
    pendingPlayers.push({ peerId: fromPeerId, name: data.name, seatIdx });
    connections[fromPeerId].send({ type: 'join_ack', seatIdx, players: [{ name: myName, seatIdx: 0 }, ...pendingPlayers] });
    // Notify all
    broadcastToClients({ type: 'lobby_update', players: [{ name: myName, seatIdx: 0 }, ...pendingPlayers] });
    updateWaitingList([myName, ...pendingPlayers.map(p => p.name)]);
    if (pendingPlayers.length >= 1) {
      document.getElementById('start-game-btn').classList.remove('hidden');
    }
  } else if (data.type === 'player_action') {
    handlePlayerAction(fromPeerId, data);
  } else if (data.type === 'chat') {
    const playerName = getNameByPeerId(fromPeerId);
    broadcastToClients({ type: 'chat', author: playerName, msg: data.msg });
    addChat(playerName, data.msg);
  }
}

function getNameByPeerId(pid) {
  const p = pendingPlayers.find(x => x.peerId === pid);
  return p ? p.name : '?';
}

function broadcastToClients(msg) {
  Object.values(connections).forEach(c => c.send(msg));
}
function broadcastAll(msg) {
  broadcastToClients(msg);
}

function handleClientMessage(data) {
  if (data.type === 'join_ack') {
    myPlayerId = data.seatIdx;
    updateWaitingList(data.players.map(p => p.name));
    setStatus('join', 'Joined! Waiting for host to start…');
  } else if (data.type === 'join_denied') {
    setStatus('join', 'Denied: ' + data.reason);
  } else if (data.type === 'lobby_update') {
    updateWaitingList(data.players.map(p => p.name));
  } else if (data.type === 'game_start') {
    startClientGame(data.state);
  } else if (data.type === 'state_update') {
    applyStateUpdate(data.state);
  } else if (data.type === 'chat') {
    addChat(data.author, data.msg);
  } else if (data.type === 'system') {
    systemChat(data.msg);
  }
}

function updateWaitingList(names) {
  const el = document.getElementById('waiting-players');
  if (!el) return;
  el.innerHTML = `<b>${names.length}</b> player${names.length !== 1 ? 's' : ''}: ${names.join(', ')}`;
}

function setStatus(tab, msg) {
  document.getElementById(tab + '-status').textContent = msg;
}

function copyCode() {
  navigator.clipboard.writeText(roomCode).catch(() => {});
  const btn = document.querySelector('.copy-btn');
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 1500);
}

// ---- Lobby: Join ----
function joinGame() {
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name) { setStatus('join', 'Please enter your name.'); return; }
  if (!code) { setStatus('join', 'Please enter a room code.'); return; }
  myName = name;
  isHost = false;

  setStatus('join', 'Connecting…');
  peer = new Peer(undefined, { debug: 0 });
  peer.on('open', id => {
    myPeerId = id;
    const conn = peer.connect(code);
    conn.on('open', () => {
      connections[code] = conn;
      roomCode = code;
      conn.send({ type: 'join_request', name });
      conn.on('data', data => handleClientMessage(data));
      conn.on('close', () => systemChat('Connection to host lost.'));
    });
    conn.on('error', e => setStatus('join', 'Could not connect: ' + e.message));
  });
  peer.on('error', e => setStatus('join', 'Error: ' + e.message));
}

// ============================================================
// GAME LOGIC (host only drives state)
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

function startGameAsHost() {
  if (pendingPlayers.length < 1) { alert('Need at least 1 other player.'); return; }
  const blindStr = document.getElementById('blind-level').value;
  const [sb, bb] = blindStr.split(',').map(Number);
  const startChips = parseInt(document.getElementById('starting-chips').value);

  const allPlayers = [
    { name: myName, peerId: myPeerId, seatIdx: 0 },
    ...pendingPlayers.map(p => ({ name: p.name, peerId: p.peerId, seatIdx: p.seatIdx }))
  ];

  gameState = initGameState(allPlayers, startChips, sb, bb);
  gameState.started = true;

  // Send full state to clients (hide hole cards)
  const clientState = sanitizeStateForBroadcast(gameState);
  broadcastAll({ type: 'game_start', state: clientState });

  // Start the game locally (host sees own cards)
  showGameScreen();
  renderGame();
  startNewHand();
}

function initGameState(players, chips, sb, bb) {
  return {
    started: false,
    players: players.map((p, i) => ({
      id: i,
      name: p.name,
      peerId: p.peerId,
      chips,
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      holeCards: []
    })),
    deck: [],
    communityCards: [],
    pot: 0,
    sidePots: [],
    dealerIdx: 0,
    activeIdx: -1,
    phase: 'waiting', // waiting, preflop, flop, turn, river, showdown
    sb, bb,
    currentBet: 0,
    lastRaiseAmount: bb,
    minRaise: bb,
    round: 0,
    actionCount: 0
  };
}

function startNewHand() {
  const gs = gameState;
  gs.round++;
  gs.deck = makeDeck();
  gs.communityCards = [];
  gs.pot = 0;
  gs.currentBet = 0;
  gs.lastRaiseAmount = gs.bb;
  gs.minRaise = gs.bb;
  gs.actionCount = 0;

  // Reset players
  gs.players.forEach(p => {
    p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false; p.holeCards = [];
  });

  // Rotate dealer
  gs.dealerIdx = (gs.dealerIdx + (gs.round > 1 ? 1 : 0)) % gs.players.length;

  // Deal hole cards
  for (let i = 0; i < 2; i++) {
    gs.players.forEach(p => { p.holeCards.push(gs.deck.pop()); });
  }

  // Post blinds
  const n = gs.players.length;
  const sbIdx = (gs.dealerIdx + 1) % n;
  const bbIdx = (gs.dealerIdx + 2) % n;

  postBlind(sbIdx, gs.sb);
  postBlind(bbIdx, gs.bb);
  gs.currentBet = gs.bb;
  gs.lastRaiseAmount = gs.bb;

  gs.phase = 'preflop';
  gs.activeIdx = (bbIdx + 1) % n;
  // skip folded/allIn (none yet)

  broadcastStateUpdate();
  renderGame();
  systemChat(`New hand #${gs.round} started. Dealer: ${gs.players[gs.dealerIdx].name}`);
}

function postBlind(idx, amount) {
  const p = gameState.players[idx];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual; p.bet = actual; p.totalBet = actual;
  gameState.pot += actual;
  if (p.chips === 0) p.allIn = true;
}

// ---- Actions ----
function handlePlayerAction(fromPeerId, data) {
  const gs = gameState;
  const actingPlayer = gs.players[gs.activeIdx];
  if (!actingPlayer) return;

  // Verify it's this player's turn
  const isMyTurn = (isHost && gs.activeIdx === 0) || actingPlayer.peerId === fromPeerId;
  if (!isMyTurn) return;

  const { action, amount } = data;

  if (action === 'fold') {
    actingPlayer.folded = true;
    systemChat(`${actingPlayer.name} folds.`);
  } else if (action === 'check') {
    if (gs.currentBet > actingPlayer.bet) return; // invalid
    systemChat(`${actingPlayer.name} checks.`);
  } else if (action === 'call') {
    const toCall = Math.min(gs.currentBet - actingPlayer.bet, actingPlayer.chips);
    actingPlayer.chips -= toCall; actingPlayer.bet += toCall;
    actingPlayer.totalBet += toCall; gs.pot += toCall;
    if (actingPlayer.chips === 0) actingPlayer.allIn = true;
    systemChat(`${actingPlayer.name} calls ${toCall}.`);
  } else if (action === 'raise') {
    const raiseBy = Math.max(amount, gs.minRaise);
    const totalNew = gs.currentBet + raiseBy;
    const toAdd = Math.min(totalNew - actingPlayer.bet, actingPlayer.chips);
    actingPlayer.chips -= toAdd; actingPlayer.bet += toAdd;
    actingPlayer.totalBet += toAdd; gs.pot += toAdd;
    gs.lastRaiseAmount = raiseBy;
    gs.minRaise = raiseBy;
    gs.currentBet = actingPlayer.bet;
    if (actingPlayer.chips === 0) actingPlayer.allIn = true;
    systemChat(`${actingPlayer.name} raises to ${gs.currentBet}.`);
    gs.actionCount = 0; // reset street count after raise
  } else if (action === 'allin') {
    const allInAmt = actingPlayer.chips;
    if (actingPlayer.bet + allInAmt > gs.currentBet) {
      gs.lastRaiseAmount = actingPlayer.bet + allInAmt - gs.currentBet;
      gs.minRaise = gs.lastRaiseAmount;
      gs.currentBet = actingPlayer.bet + allInAmt;
      gs.actionCount = 0;
    }
    gs.pot += allInAmt; actingPlayer.bet += allInAmt;
    actingPlayer.totalBet += allInAmt; actingPlayer.chips = 0;
    actingPlayer.allIn = true;
    systemChat(`${actingPlayer.name} goes ALL IN with ${allInAmt}!`);
  }

  gs.actionCount++;
  advanceAction();
}

function advanceAction() {
  const gs = gameState;
  const n = gs.players.length;
  const active = gs.players.filter(p => !p.folded);

  // Check if only one player remains
  if (active.length === 1) {
    awardPot(active);
    return;
  }

  // Check if everyone is all-in or has matched the bet
  const canAct = active.filter(p => !p.allIn);
  const allMatched = canAct.every(p => p.bet >= gs.currentBet);

  if (allMatched && gs.actionCount >= canAct.length) {
    advancePhase();
    return;
  }

  // Find next active player
  let next = (gs.activeIdx + 1) % n;
  let tries = 0;
  while ((gs.players[next].folded || gs.players[next].allIn) && tries < n) {
    next = (next + 1) % n; tries++;
  }
  gs.activeIdx = next;

  broadcastStateUpdate();
  renderGame();
}

function advancePhase() {
  const gs = gameState;
  // Reset bets for new street
  gs.players.forEach(p => { p.bet = 0; });
  gs.actionCount = 0;
  gs.minRaise = gs.bb;

  if (gs.phase === 'preflop') {
    gs.communityCards.push(gs.deck.pop(), gs.deck.pop(), gs.deck.pop());
    gs.phase = 'flop';
    gs.currentBet = 0;
    systemChat('--- FLOP ---');
  } else if (gs.phase === 'flop') {
    gs.communityCards.push(gs.deck.pop());
    gs.phase = 'turn';
    gs.currentBet = 0;
    systemChat('--- TURN ---');
  } else if (gs.phase === 'turn') {
    gs.communityCards.push(gs.deck.pop());
    gs.phase = 'river';
    gs.currentBet = 0;
    systemChat('--- RIVER ---');
  } else if (gs.phase === 'river') {
    gs.phase = 'showdown';
    doShowdown();
    return;
  }

  // Set active to first after dealer
  const n = gs.players.length;
  let next = (gs.dealerIdx + 1) % n;
  let tries = 0;
  while ((gs.players[next].folded || gs.players[next].allIn) && tries < n) {
    next = (next + 1) % n; tries++;
  }
  gs.activeIdx = next;

  broadcastStateUpdate();
  renderGame();
}

// ============================================================
// HAND EVALUATION
// ============================================================
function evalHand(cards) {
  // 7 cards -> best 5
  const combos = choose5(cards);
  let best = null;
  for (const combo of combos) {
    const score = score5(combo);
    if (!best || score > best.score) best = { score, cards: combo };
  }
  return best;
}

function choose5(cards) {
  const result = [];
  function helper(start, chosen) {
    if (chosen.length === 5) { result.push([...chosen]); return; }
    for (let i = start; i < cards.length; i++) {
      chosen.push(cards[i]); helper(i + 1, chosen); chosen.pop();
    }
  }
  helper(0, []);
  return result;
}

function score5(cards) {
  const vals = cards.map(c => RANK_VAL[c.r]).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const flush = suits.every(s => s === suits[0]);
  const straight = isStraight(vals);
  const counts = {};
  vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const cnt = Object.values(counts).sort((a, b) => b - a);
  const topVal = vals[0];

  // Straight flush
  if (flush && straight) return [8, straight, 0, 0, 0, 0];
  // Four of a kind
  if (cnt[0] === 4) {
    const four = +Object.keys(counts).find(k => counts[k] === 4);
    const kick = +Object.keys(counts).find(k => counts[k] === 1);
    return [7, four, kick, 0, 0, 0];
  }
  // Full house
  if (cnt[0] === 3 && cnt[1] === 2) {
    const three = +Object.keys(counts).find(k => counts[k] === 3);
    const two = +Object.keys(counts).find(k => counts[k] === 2);
    return [6, three, two, 0, 0, 0];
  }
  // Flush
  if (flush) return [5, ...vals];
  // Straight
  if (straight) return [4, straight, 0, 0, 0, 0];
  // Three of a kind
  if (cnt[0] === 3) {
    const three = +Object.keys(counts).find(k => counts[k] === 3);
    const kicks = vals.filter(v => v !== three);
    return [3, three, ...kicks];
  }
  // Two pair
  if (cnt[0] === 2 && cnt[1] === 2) {
    const pairs = Object.keys(counts).filter(k => counts[k] === 2).map(Number).sort((a, b) => b - a);
    const kick = vals.find(v => !pairs.includes(v));
    return [2, pairs[0], pairs[1], kick, 0, 0];
  }
  // Pair
  if (cnt[0] === 2) {
    const pair = +Object.keys(counts).find(k => counts[k] === 2);
    const kicks = vals.filter(v => v !== pair);
    return [1, pair, ...kicks];
  }
  // High card
  return [0, ...vals];
}

function isStraight(sortedVals) {
  // Normal
  let ok = true;
  for (let i = 0; i < 4; i++) if (sortedVals[i] - sortedVals[i + 1] !== 1) { ok = false; break; }
  if (ok) return sortedVals[0];
  // Wheel: A-2-3-4-5
  if (JSON.stringify(sortedVals) === JSON.stringify([14, 5, 4, 3, 2])) return 5;
  return 0;
}

const HAND_NAMES = [
  'High Card', 'One Pair', 'Two Pair', 'Three of a Kind',
  'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'
];

function handName(score) { return HAND_NAMES[score[0]] || 'High Card'; }

function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function doShowdown() {
  const gs = gameState;
  const active = gs.players.filter(p => !p.folded);
  const results = active.map(p => {
    const all7 = [...p.holeCards, ...gs.communityCards];
    const best = evalHand(all7);
    return { player: p, result: best };
  });

  results.sort((a, b) => compareScores(b.result.score, a.result.score));
  const winners = [results[0]];
  for (let i = 1; i < results.length; i++) {
    if (compareScores(results[i].result.score, winners[0].result.score) === 0) {
      winners.push(results[i]);
    }
  }

  const share = Math.floor(gs.pot / winners.length);
  winners.forEach(w => { w.player.chips += share; });

  const winStr = winners.map(w => `${w.player.name} (${handName(w.result.score)})`).join(' & ');
  gs.phase = 'showdown';
  gs.resultMessage = `${winStr} win${winners.length > 1 ? '' : 's'} ${gs.pot}!`;

  broadcastStateUpdate();
  renderGame();

  systemChat(gs.resultMessage);

  // Remove bust players
  setTimeout(() => {
    gs.players = gs.players.filter(p => p.chips > 0);
    if (gs.players.length > 1) {
      startNewHand();
    } else if (gs.players.length === 1) {
      systemChat(`🏆 ${gs.players[0].name} wins the game!`);
    }
  }, 4000);
}

function awardPot(activePlayers) {
  const gs = gameState;
  const winner = activePlayers[0];
  winner.chips += gs.pot;
  gs.resultMessage = `${winner.name} wins ${gs.pot}!`;
  gs.phase = 'showdown';
  broadcastStateUpdate();
  renderGame();
  systemChat(gs.resultMessage);
  setTimeout(() => {
    gs.players = gs.players.filter(p => p.chips > 0);
    if (gs.players.length > 1) startNewHand();
  }, 3000);
}

// ============================================================
// STATE BROADCAST
// ============================================================
function sanitizeStateForBroadcast(gs) {
  return {
    ...gs,
    players: gs.players.map((p, i) => ({
      ...p,
      // Only send hole cards to the specific player - we handle this per-send
      holeCards: [] // will be filled per player
    }))
  };
}

function broadcastStateUpdate() {
  const gs = gameState;
  // Send each player their own hole cards
  gs.players.forEach(p => {
    if (p.peerId === myPeerId) return; // host renders directly
    const conn = connections[p.peerId];
    if (!conn) return;
    const state = {
      ...gs,
      players: gs.players.map((pl, i) => ({
        ...pl,
        holeCards: (pl.id === p.id || gs.phase === 'showdown') ? pl.holeCards : (pl.folded ? pl.holeCards : [])
      }))
    };
    conn.send({ type: 'state_update', state });
  });
  // Broadcast to all for community info (non-host already handled above)
}

// ============================================================
// CLIENT SIDE
// ============================================================
function startClientGame(state) {
  gameState = state;
  showGameScreen();
  renderGame();
}

function applyStateUpdate(state) {
  gameState = state;
  renderGame();
}

// ============================================================
// UI RENDERING
// ============================================================
function showGameScreen() {
  document.getElementById('lobby-screen').classList.remove('active');
  document.getElementById('game-screen').classList.add('active');
  document.getElementById('blinds-label').textContent = `Blinds: ${gameState.sb}/${gameState.bb}`;
}

function renderGame() {
  if (!gameState) return;
  const gs = gameState;
  const me = gs.players[myPlayerId];

  // Phase label
  document.getElementById('game-phase-label').textContent =
    gs.phase === 'waiting' ? 'Waiting' :
    gs.phase === 'preflop' ? 'Pre-Flop' :
    gs.phase.charAt(0).toUpperCase() + gs.phase.slice(1);

  // Pot
  document.getElementById('pot-amount').textContent = gs.pot;

  // Community cards
  renderCommunityCards(gs.communityCards);

  // Round result
  const resultEl = document.getElementById('round-result');
  if (gs.resultMessage && gs.phase === 'showdown') {
    resultEl.textContent = gs.resultMessage;
    resultEl.classList.remove('hidden');
  } else {
    resultEl.classList.add('hidden');
    gs.resultMessage = '';
  }

  // My cards
  const myHole = document.getElementById('my-hole-cards');
  myHole.innerHTML = '';
  if (me && me.holeCards && me.holeCards.length) {
    me.holeCards.forEach(c => myHole.appendChild(makeCardEl(c, false)));
  }

  // My info
  if (me) {
    document.getElementById('my-name-label').textContent = me.name;
    document.getElementById('my-chips-label').textContent = me.chips;
    const pBar = document.getElementById('player-info-bar');
    pBar.classList.toggle('active-player', gs.activeIdx === myPlayerId);
    document.getElementById('my-dealer-btn').classList.toggle('hidden', gs.dealerIdx !== myPlayerId);
    const statusTag = document.getElementById('player-status-tag');
    statusTag.textContent = me.folded ? 'FOLDED' : me.allIn ? 'ALL IN' : '';
  }

  // Opponents
  renderOpponents(gs);

  // Action panel
  const isMyTurn = gs.activeIdx === myPlayerId && gs.phase !== 'showdown' && gs.phase !== 'waiting';
  const actionPanel = document.getElementById('action-panel');
  actionPanel.classList.toggle('hidden', !isMyTurn);

  if (isMyTurn && me) {
    const toCall = gs.currentBet - (me.bet || 0);
    document.getElementById('btn-check').disabled = toCall > 0;
    document.getElementById('btn-call').disabled = toCall <= 0 || me.chips <= 0;
    document.getElementById('btn-call').textContent = toCall > 0 ? `Call ${toCall}` : 'Call';
    document.getElementById('call-amount-label').textContent = toCall > 0 ? `To call: ${toCall}` : '';
    // Raise slider
    const slider = document.getElementById('raise-slider');
    slider.min = gs.minRaise;
    slider.max = me.chips;
    slider.value = Math.max(gs.minRaise, Math.floor(me.chips / 4));
    updateRaiseDisplay(slider.value);
  }
}

function renderCommunityCards(cards) {
  const el = document.getElementById('community-cards');
  el.innerHTML = '';
  // Placeholders
  for (let i = 0; i < 5; i++) {
    if (cards[i]) {
      el.appendChild(makeCardEl(cards[i], false));
    } else {
      const ph = document.createElement('div');
      ph.className = 'card card-back';
      ph.style.opacity = '0.2';
      el.appendChild(ph);
    }
  }
}

function makeCardEl(card, faceDown = false) {
  const el = document.createElement('div');
  if (faceDown) {
    el.className = 'card card-back';
    return el;
  }
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

// Opponent seat positions around the table
const SEAT_POSITIONS = [
  { top: '-60px', left: '50%', transform: 'translateX(-50%)' },  // top center
  { top: '10%', right: '-70px', transform: 'none' },              // right top
  { bottom: '10%', right: '-70px', transform: 'none' },           // right bottom
  { bottom: '-60px', left: '20%', transform: 'none' },            // bottom left
  { bottom: '-60px', right: '20%', transform: 'none' },           // bottom right
  { top: '10%', left: '-70px', transform: 'none' },               // left top
  { bottom: '10%', left: '-70px', transform: 'none' },            // left bottom
];

function renderOpponents(gs) {
  const el = document.getElementById('opponent-seats');
  el.innerHTML = '';
  let seatPos = 0;
  gs.players.forEach((p, i) => {
    if (i === myPlayerId) return;
    const pos = SEAT_POSITIONS[seatPos % SEAT_POSITIONS.length];
    seatPos++;

    const seat = document.createElement('div');
    seat.className = 'opponent-seat';
    Object.assign(seat.style, pos);

    // Avatar
    const av = document.createElement('div');
    av.className = 'opp-avatar' +
      (gs.activeIdx === i ? ' active-player' : '') +
      (p.folded ? ' folded' : '');
    const emojiList = ['🎩','🃏','🎰','♠','🦊','🐉','🎭','🎪'];
    av.textContent = emojiList[i % emojiList.length];

    // Dealer marker
    if (gs.dealerIdx === i) {
      const dm = document.createElement('div');
      dm.className = 'dealer-marker'; dm.textContent = 'D';
      av.appendChild(dm);
    }

    // Name
    const nm = document.createElement('div');
    nm.className = 'opp-name'; nm.textContent = p.name;

    // Chips
    const ch = document.createElement('div');
    ch.className = 'opp-chips'; ch.textContent = '₪ ' + p.chips;

    // Hole cards (face down, or revealed at showdown)
    const hc = document.createElement('div');
    hc.className = 'opp-hole-cards';
    if (p.holeCards && p.holeCards.length) {
      p.holeCards.forEach(c => {
        const revealed = gs.phase === 'showdown' && !p.folded;
        hc.appendChild(makeCardSmEl(c, !revealed));
      });
    } else if (!p.folded && gs.phase !== 'waiting') {
      for (let i = 0; i < 2; i++) hc.appendChild(makeCardSmEl(null, true));
    }

    // Bet
    if (p.bet > 0) {
      const bt = document.createElement('div');
      bt.className = 'opp-bet'; bt.textContent = '+ ' + p.bet;
      seat.appendChild(bt);
    }

    seat.appendChild(av); seat.appendChild(nm); seat.appendChild(ch);
    if (hc.children.length) seat.appendChild(hc);

    // Status
    if (p.folded) {
      const st = document.createElement('div'); st.className = 'opp-bet';
      st.textContent = 'FOLDED'; st.style.color = '#f87171';
      seat.appendChild(st);
    } else if (p.allIn) {
      const st = document.createElement('div'); st.className = 'opp-bet';
      st.textContent = 'ALL IN'; st.style.color = '#e9d5ff';
      seat.appendChild(st);
    }

    el.appendChild(seat);
  });
}

// ============================================================
// PLAYER ACTIONS (called from UI)
// ============================================================
function playerAction(action, amount) {
  const raiseAmt = parseInt(document.getElementById('raise-display').textContent) || 0;
  const msg = { type: 'player_action', action, amount: action === 'raise' ? raiseAmt : 0 };

  if (isHost) {
    // Host acts as player 0
    handlePlayerAction(myPeerId, msg);
  } else {
    // Send to host
    Object.values(connections)[0].send(msg);
  }
  closeRaise();
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
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = msg;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
