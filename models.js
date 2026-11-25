const mongoose = require("mongoose");

// Couple = permanent room
const coupleSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  pinHash: { type: String, required: true },
  players: {
    X: { type: String, required: true }, // pehle player ka naam
    O: { type: String, required: true }, // doosre player ka naam
  },
  createdAt: { type: Date, default: Date.now },
});

// Match = har khatam hui game ka result
const matchSchema = new mongoose.Schema({
  code: { type: String, required: true },
  game: { type: String, required: true },
  // duo: "X" / "O" / "draw"  |  solo: "win" / "loss" / "draw"
  result: { type: String, enum: ["X", "O", "draw", "win", "loss"], required: true },
  mode: { type: String, enum: ["duo", "solo"], default: "duo" },
  player: { type: String, enum: ["X", "O"] }, // sirf solo mein: kisne khela
  playedAt: { type: Date, default: Date.now },
});
matchSchema.index({ code: 1, playedAt: -1 });

module.exports = {
  Couple: mongoose.model("Couple", coupleSchema),
  Match: mongoose.model("Match", matchSchema),
};