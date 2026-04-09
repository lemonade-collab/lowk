# 🃏 Royal Hold'em — Texas Hold'em Multiplayer

A fully playable **multiplayer Texas Hold'em poker game** that runs entirely in the browser with no server required. Uses **WebRTC (PeerJS)** for peer-to-peer connections.

## 🚀 How to Host on GitHub Pages

1. Create a new GitHub repository (e.g. `royal-holdem`)
2. Upload all three files:
   - `index.html`
   - `style.css`
   - `poker.js`
3. Go to **Settings → Pages → Source → Deploy from branch: main**
4. Your game will be live at:  
   `https://YOUR_USERNAME.github.io/royal-holdem/`

## 🎮 How to Play

### Hosting a Game
1. Open the link and click **Host Game**
2. Enter your name, choose starting chips and blind levels
3. Click **Create Table** — a Room Code will appear
4. Share the code with friends
5. When everyone has joined, click **Start Game**

### Joining a Game
1. Open the link and click **Join Game**
2. Enter your name and the Room Code from the host
3. Click **Join Table** and wait for the host to start

## ⚙️ Features

- ♠ Full Texas Hold'em rules (Pre-Flop, Flop, Turn, River, Showdown)
- ♥ 2–8 players via WebRTC peer-to-peer (no server needed)
- ♣ Full hand evaluation (Royal Flush → High Card)
- ♦ Fold / Check / Call / Raise / All-In actions
- 💬 In-game chat
- 🎨 Luxury casino aesthetic

## ⚠️ Notes

- The Room Code **is** the host's PeerJS peer ID — share it via Discord, iMessage, etc.
- Requires an internet connection (PeerJS uses a public signaling server for the initial WebRTC handshake)
- Best played on desktop; mobile is supported but the chat panel is hidden
- If the PeerJS free tier is busy, connections may occasionally fail — try again

## 🧰 Tech Stack

- Pure HTML / CSS / JavaScript (no framework)
- [PeerJS](https://peerjs.com/) for WebRTC peer-to-peer connections
- Google Fonts (Cinzel + Rajdhani)
- GitHub Pages for hosting (free, static)
