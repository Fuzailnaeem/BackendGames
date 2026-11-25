require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { Couple, Match } = require("./models");

const PORT = process.env.PORT || 3000;
const CLIENT_URL = process.env.CLIENT_URL || "*";
const MONGO_URI = process.env.MONGO_URI;
// Aaj/hafta/mahina ki hadd is timezone se nikalti hai. Pakistan = UTC+5 = 300 minutes
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN ?? 300);

const app = express();
app.use(cors({ origin: CLIENT_URL }));

app.get("/", (req, res) => {
  const db = mongoose.connection.readyState === 1 ? "connected" : "not connected";
  res.send(`Game server chal raha hai ✅ | MongoDB: ${db}`);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ["GET", "POST"] },
});

// Jo games 2-player ke liye ready hain. Nayi game banao to yahan id add karna
const AVAILABLE_GAMES = ["tictactoe"];
// Jin games mein akele (vs computer) khel sakte hain
const SOLO_GAMES = ["tictactoe"];
const PERIODS = ["day", "week", "month", "all"];

const emptyScore = () => ({ X: 0, O: 0, draw: 0 });
const emptySolo = () => ({ win: 0, loss: 0, draw: 0 });
const safe = (cb) => (typeof cb === "function" ? cb : () => {});
const cleanName = (v) => String(v || "").trim().slice(0, 20);
const validPin = (v) => /^\d{4,8}$/.test(String(v || ""));

// ---------- PIN hashing (extra package ki zaroorat nahi) ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function checkPin(pin, stored) {
  const [salt, hash] = String(stored).split(":");
  const test = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}

async function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // confusing letters (0,O,1,I) nahi
  for (let i = 0; i < 10; i++) {
    const code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join("");
    if (!(await Couple.exists({ code }))) return code;
  }
  throw new Error("Code nahi ban paya");
}

// ---------- Scoreboard (MongoDB se) ----------
function sinceFor(period) {
  if (period === "all") return null;
  const offset = TZ_OFFSET_MIN * 60 * 1000;
  const local = new Date(Date.now() + offset); // UTC fields = local time
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();

  let startLocal;
  if (period === "day") startLocal = Date.UTC(y, m, d);
  else if (period === "week") startLocal = Date.UTC(y, m, d - ((local.getUTCDay() + 6) % 7)); // Monday se
  else if (period === "month") startLocal = Date.UTC(y, m, 1);
  else return null;

  return new Date(startLocal - offset);
}

async function getStats(code, period) {
  const since = sinceFor(period);
  const base = { code };
  if (since) base.playedAt = { $gte: since };

  // 2-player results (purane matches jin mein mode nahi likha, wo bhi duo hain)
  const duoRows = await Match.aggregate([
    { $match: { ...base, mode: { $ne: "solo" } } },
    { $group: { _id: { game: "$game", result: "$result" }, n: { $sum: 1 } } },
  ]);

  const all = emptyScore();
  const byGame = {};
  for (const r of duoRows) {
    const { game, result } = r._id;
    if (!["X", "O", "draw"].includes(result)) continue;
    if (!byGame[game]) byGame[game] = emptyScore();
    byGame[game][result] += r.n;
    all[result] += r.n;
  }

  // Akele khelne wale results (har player ke)
  const soloRows = await Match.aggregate([
    { $match: { ...base, mode: "solo" } },
    { $group: { _id: { player: "$player", result: "$result" }, n: { $sum: 1 } } },
  ]);

  const solo = { X: emptySolo(), O: emptySolo() };
  for (const r of soloRows) {
    const { player, result } = r._id;
    if (solo[player] && result in solo[player]) solo[player][result] += r.n;
  }

  const recent = await Match.find(base)
    .sort({ playedAt: -1 })
    .limit(8)
    .select("game result mode player playedAt -_id")
    .lean();

  return { period, all, byGame, solo, recent };
}

// ---------- Live rooms (memory mein, sirf chalti game ke liye) ----------
const live = {};

function getLive(couple) {
  let room = live[couple.code];
  if (!room) {
    room = {
      code: couple.code,
      names: { X: couple.players.X, O: couple.players.O },
      sockets: { X: null, O: null }, // kaun online hai
      game: null, // null = Hub
      ttt: newTTT(),
      totals: Object.fromEntries(AVAILABLE_GAMES.map((g) => [g, emptyScore()])),
      timer: null,
    };
    live[couple.code] = room;
    loadTotals(room); // DB se purane scores laao (async)
  }
  return room;
}

async function loadTotals(room) {
  try {
    const stats = await getStats(room.code, "all");
    for (const g of AVAILABLE_GAMES) {
      room.totals[g] = stats.byGame[g] || emptyScore();
    }
    broadcast(room);
  } catch (err) {
    console.error("Totals load error:", err.message);
  }
}

const bothOnline = (room) => Boolean(room.sockets.X && room.sockets.O);

function publicState(room) {
  const t = room.ttt;
  return {
    code: room.code,
    names: room.names,
    online: { X: Boolean(room.sockets.X), O: Boolean(room.sockets.O) },
    game: room.game,
    totals: room.totals,
    ttt: { board: t.board, turn: t.turn, winner: t.winner, line: t.line, draw: t.draw },
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", publicState(room));
}

function finish(room, game, result) {
  room.totals[game][result] += 1;
  Match.create({ code: room.code, game, result, mode: "duo" }).catch((err) =>
    console.error("Match save error:", err.message)
  );
}

// ---------- Tic-Tac-Toe ----------
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function newTTT() {
  return { board: Array(9).fill(null), turn: "X", starter: "X", winner: null, line: null, draw: false };
}

function resetTTTBoard(t) {
  t.board = Array(9).fill(null);
  t.turn = t.starter;
  t.winner = null;
  t.line = null;
  t.draw = false;
}

function checkResult(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line, draw: false };
    }
  }
  return { winner: null, line: null, draw: board.every((c) => c !== null) };
}

// ---------- Socket helpers ----------
function mine(socket) {
  const room = live[socket.data.code];
  return room && room.sockets[socket.data.slot] === socket.id ? room : null;
}

function detach(socket) {
  const room = live[socket.data.code];
  const slot = socket.data.slot;
  if (room && slot && room.sockets[slot] === socket.id) {
    room.sockets[slot] = null;
    socket.leave(room.code);
    if (!room.sockets.X && !room.sockets.O) {
      // dono offline: 10 min baad memory saaf (DB mein sab safe rehta hai)
      room.timer = setTimeout(() => delete live[room.code], 10 * 60 * 1000);
    } else {
      broadcast(room);
    }
  }
  socket.data.code = null;
  socket.data.slot = null;
}

async function attach(socket, couple, slot) {
  if (socket.data.code) detach(socket);

  const room = getLive(couple);
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  // Agar is slot pe koi aur socket hai (doosra tab/purana dead connection), usse hata do
  const oldId = room.sockets[slot];
  if (oldId && oldId !== socket.id) {
    const old = io.sockets.sockets.get(oldId);
    if (old) {
      old.leave(room.code);
      old.data.code = null;
      old.data.slot = null;
      old.emit("kicked");
    }
  }

  room.sockets[slot] = socket.id;
  socket.join(room.code);
  socket.data.code = room.code;
  socket.data.slot = slot;
  broadcast(room);
}

// Code + PIN check. Galat attempts zyada hon to connection band
async function verify(socket, rawCode, rawPin) {
  const code = String(rawCode || "").trim().toUpperCase();
  const pin = String(rawPin || "");
  const couple = code ? await Couple.findOne({ code }) : null;

  if (couple && checkPin(pin, couple.pinHash)) {
    socket.data.fails = 0;
    return couple;
  }
  socket.data.fails = (socket.data.fails || 0) + 1;
  if (socket.data.fails >= 8) socket.disconnect(true);
  return null;
}

const wrongCreds = { ok: false, wrong: true, error: "Room code ya PIN galat hai." };
const serverError = { ok: false, error: "Server mein masla aa gaya. Dobara try karo." };

// ---------- Socket events ----------
io.on("connection", (socket) => {
  // Naya couple room banao
  socket.on("create-couple", async (data, cb) => {
    cb = safe(cb);
    try {
      const name = cleanName(data?.name);
      const partner = cleanName(data?.partner);
      const pin = String(data?.pin || "");

      if (!name || !partner) return cb({ ok: false, error: "Dono ke naam likho." });
      if (name.toLowerCase() === partner.toLowerCase())
        return cb({ ok: false, error: "Dono ke naam alag hone chahiye." });
      if (!validPin(pin)) return cb({ ok: false, error: "PIN 4 se 8 digits ka hona chahiye." });

      const code = await makeCode();
      const couple = await Couple.create({
        code,
        pinHash: hashPin(pin),
        players: { X: name, O: partner },
      });
      await attach(socket, couple, "X");
      cb({ ok: true, code, slot: "X" });
    } catch (err) {
      console.error(err);
      cb(serverError);
    }
  });

  // Step 1 of "Room Kholo": code + PIN sahi hai? Sahi ho to dono ke naam bhejo
  socket.on("check-couple", async (data, cb) => {
    cb = safe(cb);
    try {
      const couple = await verify(socket, data?.code, data?.pin);
      if (!couple) return cb(wrongCreds);
      cb({ ok: true, players: { X: couple.players.X, O: couple.players.O } });
    } catch (err) {
      console.error(err);
      cb(serverError);
    }
  });

  // Room kholo (naam chun ke) ya auto-reconnect
  socket.on("join-couple", async (data, cb) => {
    cb = safe(cb);
    try {
      const slot = data?.slot === "X" || data?.slot === "O" ? data.slot : null;
      if (!slot) return cb({ ok: false, error: "Apna naam chuno." });

      const couple = await verify(socket, data?.code, data?.pin);
      if (!couple) return cb(wrongCreds);

      await attach(socket, couple, slot);
      cb({ ok: true, code: couple.code, slot });
    } catch (err) {
      console.error(err);
      cb(serverError);
    }
  });

  // Scoreboard (filter: day / week / month / all)
  socket.on("get-stats", async (data, cb) => {
    cb = safe(cb);
    try {
      const room = mine(socket);
      if (!room) return cb({ ok: false, error: "Pehle room kholo." });
      const period = PERIODS.includes(data?.period) ? data.period : "day";
      const stats = await getStats(room.code, period);
      cb({ ok: true, ...stats });
    } catch (err) {
      console.error(err);
      cb({ ok: false, error: "Score load nahi ho paya." });
    }
  });

  // Akele (vs computer) khelne ka result save karo. Game client pe chalti hai
  socket.on("solo-result", (data) => {
    const room = mine(socket);
    if (!room) return;

    const game = data?.game;
    const result = data?.result;
    if (!SOLO_GAMES.includes(game)) return;
    if (!["win", "loss", "draw"].includes(result)) return;

    Match.create({
      code: room.code,
      game,
      result,
      mode: "solo",
      player: socket.data.slot,
    }).catch((err) => console.error("Solo match save error:", err.message));
  });

  // Hub se 2-player game chuno
  socket.on("select-game", (gameId) => {
    const room = mine(socket);
    if (!room || !bothOnline(room)) return;
    if (!AVAILABLE_GAMES.includes(gameId)) return;

    room.game = gameId;
    if (gameId === "tictactoe") resetTTTBoard(room.ttt);
    broadcast(room);
  });

  socket.on("back-to-hub", () => {
    const room = mine(socket);
    if (!room) return;
    room.game = null;
    broadcast(room);
  });

  // ----- Tic-Tac-Toe (2 players) -----
  socket.on("make-move", (index) => {
    const room = mine(socket);
    if (!room || room.game !== "tictactoe" || !bothOnline(room)) return;

    const t = room.ttt;
    const slot = socket.data.slot;
    if (t.winner || t.draw) return;
    if (slot !== t.turn) return;
    if (!Number.isInteger(index) || index < 0 || index > 8 || t.board[index] !== null) return;

    t.board[index] = slot;

    const result = checkResult(t.board);
    if (result.winner) {
      t.winner = result.winner;
      t.line = result.line;
      finish(room, "tictactoe", result.winner);
    } else if (result.draw) {
      t.draw = true;
      finish(room, "tictactoe", "draw");
    } else {
      t.turn = t.turn === "X" ? "O" : "X";
    }
    broadcast(room);
  });

  socket.on("rematch", () => {
    const room = mine(socket);
    if (!room || room.game !== "tictactoe") return;

    const t = room.ttt;
    if (!t.winner && !t.draw) return;

    t.starter = t.starter === "X" ? "O" : "X"; // baari baari pehla move
    resetTTTBoard(t);
    broadcast(room);
  });

  socket.on("disconnect", () => detach(socket));
});

// ---------- Start ----------
async function start() {
  if (!MONGO_URI) {
    console.error("MONGO_URI nahi mila. server/.env file check karo.");
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB connected ✅");
  } catch (err) {
    console.error("MongoDB connect nahi hua:", err.message);
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`Server chal raha hai port ${PORT} par`));
}

start();