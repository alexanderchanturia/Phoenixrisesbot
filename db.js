const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'phoenix.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,           -- Telegram user id
    username TEXT,
    coins REAL NOT NULL DEFAULT 0,
    per_tap REAL NOT NULL DEFAULT 1,
    energy INTEGER NOT NULL DEFAULT 1000,
    max_energy INTEGER NOT NULL DEFAULT 1000,
    energy_regen_per_sec REAL NOT NULL DEFAULT 1,
    tap_level INTEGER NOT NULL DEFAULT 1,
    energy_level INTEGER NOT NULL DEFAULT 1,
    regen_level INTEGER NOT NULL DEFAULT 1,
    last_seen INTEGER NOT NULL
  );
`);

// Upgrade cost curves. Each level costs more and gives more.
const UPGRADES = {
  tap: {
    baseCost: 50,
    growth: 1.6,
    apply: (u) => { u.per_tap += 1; }
  },
  energy: {
    baseCost: 80,
    growth: 1.6,
    apply: (u) => { u.max_energy += 500; u.energy = u.max_energy; }
  },
  regen: {
    baseCost: 120,
    growth: 1.8,
    apply: (u) => { u.energy_regen_per_sec += 0.5; }
  }
};

function costFor(kind, currentLevel) {
  const cfg = UPGRADES[kind];
  return Math.round(cfg.baseCost * Math.pow(cfg.growth, currentLevel - 1));
}

function getOrCreateUser(id, username) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO users (id, username, coins, per_tap, energy, max_energy, energy_regen_per_sec, last_seen)
      VALUES (?, ?, 0, 1, 1000, 1000, 1, ?)
    `).run(id, username || '', now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  return regenEnergy(user);
}

// Recompute energy based on elapsed real time since last_seen, then persist.
function regenEnergy(user) {
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - user.last_seen) / 1000);
  const regained = elapsedSec * user.energy_regen_per_sec;
  const newEnergy = Math.min(user.max_energy, user.energy + regained);
  db.prepare('UPDATE users SET energy = ?, last_seen = ? WHERE id = ?')
    .run(newEnergy, now, user.id);
  user.energy = newEnergy;
  user.last_seen = now;
  return user;
}

function applyTaps(id, tapCount) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  user = regenEnergy(user);

  const affordableTaps = Math.min(tapCount, Math.floor(user.energy));
  if (affordableTaps <= 0) return user;

  const earned = affordableTaps * user.per_tap;
  const newCoins = user.coins + earned;
  const newEnergy = user.energy - affordableTaps;

  db.prepare('UPDATE users SET coins = ?, energy = ? WHERE id = ?')
    .run(newCoins, newEnergy, id);

  user.coins = newCoins;
  user.energy = newEnergy;
  return user;
}

function buyUpgrade(id, kind) {
  if (!UPGRADES[kind]) return { error: 'unknown_upgrade' };
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return { error: 'no_user' };
  user = regenEnergy(user);

  const levelField = `${kind}_level`;
  const currentLevel = user[levelField];
  const cost = costFor(kind, currentLevel);

  if (user.coins < cost) return { error: 'not_enough_coins', cost };

  user.coins -= cost;
  UPGRADES[kind].apply(user);
  user[levelField] = currentLevel + 1;

  db.prepare(`
    UPDATE users SET coins = ?, per_tap = ?, max_energy = ?, energy = ?,
      energy_regen_per_sec = ?, tap_level = ?, energy_level = ?, regen_level = ?
    WHERE id = ?
  `).run(
    user.coins, user.per_tap, user.max_energy, user.energy,
    user.energy_regen_per_sec, user.tap_level, user.energy_level, user.regen_level,
    id
  );

  return { user, nextCost: costFor(kind, user[levelField]) };
}

function topUsers(limit = 20) {
  return db.prepare('SELECT username, coins FROM users ORDER BY coins DESC LIMIT ?').all(limit);
}

module.exports = { db, getOrCreateUser, applyTaps, buyUpgrade, costFor, topUsers, UPGRADES };
