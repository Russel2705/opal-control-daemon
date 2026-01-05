const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const Database = require("better-sqlite3");
const { execFile } = require("child_process");

// ===== ENV =====
const MODE = (process.env.MODE || "paid").toLowerCase();
const IS_PAID = MODE === "paid";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);

const OWNER_ID = Number(process.env.OWNER_ID || 0);
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s))
  .filter(n => Number.isFinite(n) && n > 0);

const DB_PATH = process.env.DB_PATH || "/var/lib/opal-daemon/app.db";

const HOST = process.env.ZIVPN_HOST;
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE || 20);

const SERVER_TITLE = process.env.SERVER_TITLE || "🟦 🇲🇨ID SERVER";
const QUOTA_GB = Number(process.env.QUOTA_GB || 150);
const IP_LIMIT = Number(process.env.IP_LIMIT || 2);
const DISPLAY_PRICE_PER_DAY = Number(process.env.DISPLAY_PRICE_PER_DAY || 0);
const DISPLAY_PRICE_PER_MONTH = Number(process.env.DISPLAY_PRICE_PER_MONTH || 0);

// FREE access control
const FREE_ACCESS_ENV = (process.env.FREE_ACCESS || "public").toLowerCase();
const FREE_REQUIRE_CHANNEL = (process.env.FREE_REQUIRE_CHANNEL || "").trim();

// PAID pricing
const PRICE_1 = Number(process.env.PRICE_1 || 0);
const PRICE_14 = Number(process.env.PRICE_14 || 0);
const PRICE_30 = Number(process.env.PRICE_30 || 0);

// Pakasir (paid)
const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/pakasir/webhook";
const PORT = Number(process.env.PORT || 9000);

// Trial (paid)
const TRIAL_ENABLED = (process.env.TRIAL_ENABLED || "true").toLowerCase() === "true";
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 1);
const TRIAL_ONCE_PER_USER = (process.env.TRIAL_ONCE_PER_USER || "true").toLowerCase() === "true";
const TRIAL_PASSWORD_MODE = (process.env.TRIAL_PASSWORD_MODE || "auto").toLowerCase(); // auto|manual
const TRIAL_PREFIX = (process.env.TRIAL_PREFIX || "TR").toUpperCase();
const TRIAL_MAX_DAILY = Number(process.env.TRIAL_MAX_DAILY || 50);

if (!BOT_TOKEN) { console.error("Missing BOT_TOKEN"); process.exit(1); }
if (!HOST) { console.error("Missing ZIVPN_HOST"); process.exit(1); }
if (IS_PAID && (!PAKASIR_SLUG || !PAKASIR_API_KEY)) {
  console.error("MODE=paid but missing PAKASIR_SLUG/PAKASIR_API_KEY");
  process.exit(1);
}

function isOwner(tgId) {
  return OWNER_ID && Number(tgId) === Number(OWNER_ID);
}
function isAdmin(tgId) {
  if (isOwner(tgId)) return true;
  if (ADMIN_ID && Number(tgId) === Number(ADMIN_ID)) return true;
  return ADMIN_IDS.includes(Number(tgId));
}

function rupiah(n) {
  const x = Number(n || 0);
  return "Rp" + x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// ===== INIT =====
const bot = new Telegraf(BOT_TOKEN);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  saldo INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  order_id TEXT PRIMARY KEY,
  tg_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  password TEXT NOT NULL,
  expired_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allowlist (
  tg_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trials (
  tg_id INTEGER PRIMARY KEY,
  used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bans (
  tg_id INTEGER PRIMARY KEY,
  reason TEXT,
  banned_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_active_pass ON accounts(password, status);
CREATE INDEX IF NOT EXISTS idx_accounts_tg ON accounts(tg_id);
`);

try { db.prepare(`ALTER TABLE accounts ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0`).run(); } catch {}

// ===== Settings =====
function settingGet(key) {
  return db.prepare(`SELECT value FROM bot_settings WHERE key=?`).get(key)?.value;
}
function settingSet(key, value) {
  db.prepare(`INSERT INTO bot_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}
if (!settingGet("FREE_ACCESS")) settingSet("FREE_ACCESS", FREE_ACCESS_ENV);

// ===== Helpers =====
function upsertUser(tgId) {
  db.prepare(`INSERT OR IGNORE INTO users(tg_id) VALUES(?)`).run(tgId);
  return db.prepare(`SELECT tg_id, saldo, role FROM users WHERE tg_id=?`).get(tgId);
}
function getSaldo(tgId) {
  return db.prepare(`SELECT saldo FROM users WHERE tg_id=?`).get(tgId)?.saldo || 0;
}
function addSaldo(tgId, amount) {
  db.prepare(`UPDATE users SET saldo = saldo + ? WHERE tg_id=?`).run(amount, tgId);
}
function debitSaldo(tgId, amount) {
  const saldo = getSaldo(tgId);
  if (saldo < amount) return false;
  db.prepare(`UPDATE users SET saldo = saldo - ? WHERE tg_id=?`).run(amount, tgId);
  return true;
}

function isBanned(tgId) {
  return !!db.prepare(`SELECT 1 FROM bans WHERE tg_id=?`).get(tgId);
}
function banUser(tgId, reason="") {
  db.prepare(`
    INSERT INTO bans(tg_id,reason) VALUES(?,?)
    ON CONFLICT(tg_id) DO UPDATE SET reason=excluded.reason, banned_at=datetime('now')
  `).run(tgId, reason);
}
function unbanUser(tgId) {
  db.prepare(`DELETE FROM bans WHERE tg_id=?`).run(tgId);
}

function validPassword(p) {
  return typeof p === "string" && p.length >= 3 && p.length <= 32 && !/[,\s"]/.test(p);
}
function nowIso() { return new Date().toISOString(); }
function addDaysIsoFrom(baseIso, days) {
  const d = new Date(baseIso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
function fmtWIB(iso) {
  const d = new Date(iso);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} WIB`;
}
function serverActiveCount() {
  return db.prepare(`SELECT COUNT(*) AS c FROM accounts WHERE status='active'`).get()?.c || 0;
}
function getPriceByDays(days) {
  if (!IS_PAID) return 0;
  if (days === 1) return PRICE_1;
  if (days === 14) return PRICE_14;
  if (days === 30) return PRICE_30;
  return 0;
}
function cardDisplayPricePerDay() {
  if (!IS_PAID) return 0;
  if (DISPLAY_PRICE_PER_DAY > 0) return DISPLAY_PRICE_PER_DAY;
  return PRICE_1 > 0 ? PRICE_1 : 0;
}
function cardDisplayPricePerMonth() {
  if (!IS_PAID) return 0;
  if (DISPLAY_PRICE_PER_MONTH > 0) return DISPLAY_PRICE_PER_MONTH;
  return PRICE_30 > 0 ? PRICE_30 : 0;
}
function serverCardText() {
  const used = serverActiveCount();
  const total = MAX_ACTIVE;
  const status = used < total ? "✅ Tersedia" : "❌ Penuh";

  const header =
`╔══════════════════════╗
  ${SERVER_TITLE}
╚══════════════════════╝`;

  const priceDay = IS_PAID ? rupiah(cardDisplayPricePerDay()) : "GRATIS";
  const priceMonth = IS_PAID ? rupiah(cardDisplayPricePerMonth()) : "GRATIS";

  return `${header}
🛜 Domain: ${HOST}
💳 Harga/Hari: ${priceDay}
📆 Harga/Bulan: ${priceMonth}
📡 Quota: ${QUOTA_GB} GB
🔐 IP Limit: ${IP_LIMIT} IP
👥 Akun Terpakai: ${used}/${total}
📌 Status: ${status}`;
}

// ===== ZiVPN integration (NO sudo) =====
function zivpnAddPassword(password) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/local/bin/zivpn-passwd-manager",
      ["add", password],
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || stdout || err.message || "").toString()));
        resolve((stdout || "").toString().trim());
      }
    );
  });
}
function zivpnDelPassword(password) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/local/bin/zivpn-passwd-manager",
      ["del", password],
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || stdout || err.message || "").toString()));
        resolve((stdout || "").toString().trim());
      }
    );
  });
}

// ===== Pakasir =====
function pakasirPayLink(orderId, amount) {
  return `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_SLUG)}/${amount}?order_id=${encodeURIComponent(orderId)}`;
}
async function pakasirVerify(orderId, amount) {
  const url = "https://app.pakasir.com/api/transactiondetail";
  const res = await axios.get(url, {
    params: { project: PAKASIR_SLUG, amount, order_id: orderId, api_key: PAKASIR_API_KEY },
    timeout: 15000
  });
  return res.data;
}

// ===== FREE access =====
function allowlistHas(tgId) {
  return !!db.prepare(`SELECT 1 FROM allowlist WHERE tg_id=?`).get(tgId);
}
function freeAccessMode() {
  return (settingGet("FREE_ACCESS") || FREE_ACCESS_ENV || "public").toLowerCase();
}
async function isAllowedFree(ctx) {
  if (MODE !== "free") return true;
  const tgId = ctx.from?.id;
  if (!tgId) return false;
  if (isAdmin(tgId)) return true;

  const requireChannelOk = async () => {
    if (!FREE_REQUIRE_CHANNEL) return true;
    try {
      const m = await ctx.telegram.getChatMember(FREE_REQUIRE_CHANNEL, tgId);
      const st = (m.status || "").toLowerCase();
      return ["member", "administrator", "creator"].includes(st);
    } catch {
      return false;
    }
  };

  const m = freeAccessMode();
  if (m === "public") return await requireChannelOk();
  if (!allowlistHas(tgId)) return false;
  return await requireChannelOk();
}

// ===== Trial helpers =====
function trialUsed(tgId) {
  return !!db.prepare(`SELECT 1 FROM trials WHERE tg_id=?`).get(tgId);
}
function markTrialUsed(tgId) {
  db.prepare(`INSERT OR IGNORE INTO trials(tg_id) VALUES(?)`).run(tgId);
}
function trialDailyCount() {
  return db.prepare(`SELECT COUNT(*) AS c FROM trials WHERE date(used_at,'localtime') = date('now','localtime')`).get()?.c || 0;
}
function genTrialPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${TRIAL_PREFIX}-${s}`;
}

// ===== Middleware: ban + FREE gate =====
bot.use(async (ctx, next) => {
  const tgId = ctx.from?.id;

  if (tgId && isBanned(tgId) && !isAdmin(tgId)) {
    if (ctx.updateType === "message" || ctx.updateType === "callback_query") {
      try { await ctx.reply("⛔ Akun Anda diblokir. Hubungi admin."); } catch {}
    }
    return;
  }

  if (MODE === "free") {
    const ok = await isAllowedFree(ctx);
    if (!ok) {
      const msg =
`⛔ Akses ditutup (MODE FREE: ${freeAccessMode().toUpperCase()}).

ID Anda: ${tgId}
Silakan kirim ID ini ke admin untuk di-allow.`;
      if (ctx.updateType === "message" || ctx.updateType === "callback_query") {
        try { await ctx.reply(msg); } catch {}
      }
      return;
    }
  }

  return next();
});

// ===== UI keyboards =====
const MAIN_KB_FREE = Markup.keyboard([
  ["➕ Buat Akun", "♻️ Perpanjang Akun"],
  ["📌 Akun Saya", "📞 Bantuan"]
]).resize();

const MAIN_KB_PAID_BASE = Markup.keyboard([
  ["➕ Buat Akun", "♻️ Perpanjang Akun"],
  ["⏳ Trial Akun", "💰 TopUp Saldo"],
  ["📌 Akun Saya", "📞 Bantuan"]
]).resize();

function MAIN_KB(ctx) {
  const base = IS_PAID ? MAIN_KB_PAID_BASE : MAIN_KB_FREE;
  if (!ctx) return base;

  if (isAdmin(ctx.from.id)) {
    if (IS_PAID) {
      return Markup.keyboard([
        ["➕ Buat Akun", "♻️ Perpanjang Akun"],
        ["⏳ Trial Akun", "💰 TopUp Saldo"],
        ["📌 Akun Saya", "📞 Bantuan"],
        ["⚙️ Admin Panel"]
      ]).resize();
    }
    return Markup.keyboard([
      ["➕ Buat Akun", "♻️ Perpanjang Akun"],
      ["📌 Akun Saya", "📞 Bantuan"],
      ["⚙️ Admin Panel"]
    ]).resize();
  }

  return base;
}

function backToMenuKb() { return Markup.keyboard([["🔙 Kembali ke Menu Utama"]]).resize(); }

const state = new Map(); // tgId -> session

// ===== Admin: FREE access commands =====
bot.command("free", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const v = (parts[1] || "").toLowerCase();
  if (!["public", "private"].includes(v)) return ctx.reply("Usage: /free public  atau  /free private");
  settingSet("FREE_ACCESS", v);
  return ctx.reply(`✅ FREE_ACCESS diubah ke: ${v.toUpperCase()}`);
});

bot.command("allow", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const id = Number(parts[1] || 0);
  if (!Number.isFinite(id) || id <= 0) return ctx.reply("Usage: /allow 123456789");
  db.prepare(`INSERT OR IGNORE INTO allowlist(tg_id) VALUES(?)`).run(id);
  return ctx.reply(`✅ Allowed: ${id}`);
});

bot.command("deny", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const id = Number(parts[1] || 0);
  if (!Number.isFinite(id) || id <= 0) return ctx.reply("Usage: /deny 123456789");
  db.prepare(`DELETE FROM allowlist WHERE tg_id=?`).run(id);
  return ctx.reply(`✅ Removed: ${id}`);
});

bot.command("allowlist", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const rows = db.prepare(`SELECT tg_id, created_at FROM allowlist ORDER BY created_at DESC LIMIT 50`).all();
  if (!rows.length) return ctx.reply("Allowlist kosong.");
  let msg = "✅ Allowlist (max 50):\n\n";
  for (const r of rows) msg += `• ${r.tg_id} (${r.created_at})\n`;
  return ctx.reply(msg.trim());
});

// ===== /start =====
async function showStart(ctx) {
  const u = upsertUser(ctx.from.id);
  const active = serverActiveCount();

  const saldoText = IS_PAID ? `Saldo  : ${rupiah(u.saldo)}\n` : "";
  const modeText = IS_PAID ? "Mode   : PAID\n" : `Mode   : FREE (${freeAccessMode().toUpperCase()})\n`;

  const text =
`⚡ OPAL SERVICE ⚡

👤 Profil
Nama   : ${ctx.from.first_name}
ID     : ${u.tg_id}
${saldoText}${modeText}
🖥 Server
Host  : ${HOST}
Slot  : ${active}/${MAX_ACTIVE}

Pilih menu 👇`;

  return ctx.reply(text, MAIN_KB(ctx));
}

bot.start(showStart);
bot.command("start", showStart);
bot.hears("🔙 Kembali ke Menu Utama", showStart);

bot.hears("📞 Bantuan", async (ctx) => {
  const text =
`📞 BANTUAN

• Paket: 1 / 14 / 30 hari
• Password wajib unik (tidak boleh sama)
• Format konek: isi Host + Password
${IS_PAID ? "• TopUp minimal Rp 10.000\n" : ""}
${MODE === "free" ? `• FREE Access: ${freeAccessMode().toUpperCase()}\n` : ""}

Catatan:
• Jika FREE PRIVATE, kirim ID anda ke admin untuk di-allow.`;
  return ctx.reply(text, MAIN_KB(ctx));
});

// ===== Admin Panel =====
bot.hears("⚙️ Admin Panel", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  return ctx.reply(
    "⚙️ ADMIN PANEL\nPilih aksi:",
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 Statistik", "ADM:STATS")],
      [Markup.button.callback("👤 Info User", "ADM:USERINFO")],
      [Markup.button.callback("➕ Create Akun (bypass)", "ADM:CREATE")],
      [Markup.button.callback("♻️ Extend Akun", "ADM:EXTEND")],
      [Markup.button.callback("🗑 Hapus Akun", "ADM:DELACC")],
      [Markup.button.callback("⛔ Ban User", "ADM:BAN"), Markup.button.callback("✅ Unban", "ADM:UNBAN")],
      [Markup.button.callback("🧹 Delete User (OWNER)", "ADM:DELUSER")],
      [Markup.button.callback("🔙 Kembali", "BACK_MENU")]
    ])
  );
});

// ===== PAID: TopUp =====
if (IS_PAID) {
  bot.hears("💰 TopUp Saldo", async (ctx) => {
    upsertUser(ctx.from.id);
    return ctx.reply(
      `💰 TOPUP SALDO\n\nMinimal TopUp: Rp 10.000\nPilih nominal atau input manual:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("TopUp 10.000", "TOPUP:10000"), Markup.button.callback("TopUp 20.000", "TOPUP:20000")],
        [Markup.button.callback("TopUp 50.000", "TOPUP:50000")],
        [Markup.button.callback("✍️ Input Nominal", "TOPUP_INPUT")],
        [Markup.button.callback("🔙 Kembali", "BACK_MENU")]
      ])
    );
  });
}

// ===== PAID: Trial =====
if (IS_PAID) {
  bot.hears("⏳ Trial Akun", async (ctx) => {
    upsertUser(ctx.from.id);

    if (!TRIAL_ENABLED) return ctx.reply("Trial sedang dinonaktifkan.", MAIN_KB(ctx));
    if (TRIAL_ONCE_PER_USER && trialUsed(ctx.from.id)) return ctx.reply("Anda sudah pernah menggunakan trial.", MAIN_KB(ctx));
    if (trialDailyCount() >= TRIAL_MAX_DAILY) return ctx.reply("Kuota trial hari ini sudah habis. Coba besok ya.", MAIN_KB(ctx));

    const used = serverActiveCount();
    if (used >= MAX_ACTIVE) return ctx.reply("Server penuh. Trial tidak tersedia saat ini.", MAIN_KB(ctx));

    const info =
`${serverCardText()}

⏳ TRIAL:
• Durasi: ${TRIAL_DAYS} hari
• 1x per user (Telegram)
• Tidak bisa diperpanjang`;

    return ctx.reply(info, Markup.inlineKeyboard([
      [Markup.button.callback("✅ Ambil Trial", "TRIAL:GO")],
      [Markup.button.callback("🔙 Kembali", "BACK_MENU")]
    ]));
  });
}

// ===== Buy shows CARD =====
bot.hears("➕ Buat Akun", async (ctx) => {
  upsertUser(ctx.from.id);
  const used = serverActiveCount();
  const penuh = used >= MAX_ACTIVE;
  const text = serverCardText();

  return ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback(penuh ? "❌ SERVER PENUH" : "✅ PILIH SERVER", "SRV:1")],
    [Markup.button.callback("🔙 Kembali", "BACK_MENU")]
  ]));
});

bot.hears("📌 Akun Saya", async (ctx) => {
  const tgId = ctx.from.id;
  upsertUser(tgId);

  const rows = db.prepare(`
    SELECT password, expired_at, status, COALESCE(is_trial,0) AS is_trial
    FROM accounts
    WHERE tg_id=?
    ORDER BY id DESC
    LIMIT 10
  `).all(tgId);

  if (!rows.length) return ctx.reply("📌 Anda belum punya akun.", MAIN_KB(ctx));

  let msg = "📌 AKUN ANDA (Terakhir 10)\n\n";
  for (const r of rows) {
    msg += `Domain   : ${HOST}\nPassword : ${r.password}\nExpired  : ${fmtWIB(r.expired_at)}\nStatus   : ${r.status}${r.is_trial ? " (TRIAL)" : ""}\n\n`;
  }
  return ctx.reply(msg.trim(), MAIN_KB(ctx));
});

bot.hears("♻️ Perpanjang Akun", async (ctx) => {
  const tgId = ctx.from.id;
  upsertUser(tgId);

  // trial tidak bisa diperpanjang
  const activeList = db.prepare(`
    SELECT id, password, expired_at
    FROM accounts
    WHERE tg_id=? AND status='active' AND (COALESCE(is_trial,0)=0)
    ORDER BY expired_at ASC
    LIMIT 20
  `).all(tgId);

  if (!activeList.length) return ctx.reply("Anda belum punya akun aktif (non-trial) untuk diperpanjang.", MAIN_KB(ctx));

  const buttons = activeList.map(a => [Markup.button.callback(
    `${a.password} (exp ${fmtWIB(a.expired_at)})`,
    `RENEW_PICK:${a.id}`
  )]);

  return ctx.reply("♻️ Pilih akun yang mau diperpanjang:", Markup.inlineKeyboard([
    ...buttons,
    [Markup.button.callback("🔙 Kembali", "BACK_MENU")]
  ]));
});

// ===== Callbacks =====
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data || "";
  const tgId = ctx.from.id;
  upsertUser(tgId);

  if (data === "BACK_MENU") {
    await ctx.answerCbQuery();
    return showStart(ctx);
  }

  // Admin panel callbacks
  if (data === "ADM:STATS") {
    if (!isAdmin(tgId)) return ctx.answerCbQuery("No access", { show_alert: true });
    await ctx.answerCbQuery();

    const totalUsers = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
    const totalActive = db.prepare(`SELECT COUNT(*) c FROM accounts WHERE status='active'`).get().c;
    const totalExpired = db.prepare(`SELECT COUNT(*) c FROM accounts WHERE status='expired'`).get().c;
    const banned = db.prepare(`SELECT COUNT(*) c FROM bans`).get().c;

    return ctx.reply(
`📊 STATISTIK
Users        : ${totalUsers}
Akun aktif   : ${totalActive}
Akun expired : ${totalExpired}
Banned user  : ${banned}
Slot         : ${totalActive}/${MAX_ACTIVE}`, MAIN_KB(ctx)
    );
  }

  if (data === "ADM:USERINFO") {
    if (!isAdmin(tgId)) return ctx.answerCbQuery("No access", { show_alert: true });
    state.set(tgId, { mode: "ADM_USERINFO" });
    await ctx.answerCbQuery();
    return ctx.reply("Kirim Telegram ID user yang mau dicek. Contoh: 123456789", backToMenuKb());
  }

  if (data === "ADM:CREATE") {
    if (!isAdmin(tgId)) return ctx.answerCbQuery("No access", { show_alert: true });
    state.set(tgId, { mode: "ADM_CREATE" });
    await ctx.answerCbQuery();
    return ctx.reply("Format:\nCREATE <tg_id> <days> <password>\nContoh: CREATE 123456789 30 abc123", backToMenuKb());
  }

  if (data === "ADM:EXTEND") {
    if (!isAdmin(tgId)) return ctx.answerCbQuery("No access", { show_alert: true });
    state.set(tgId, { mode: "ADM_EXTEND" });
    await ctx.answerCbQuery();
    return ctx.reply("Format:\nEXTEND <password> <days>\nContoh: EXTEND abc123 14", backToMenuKb());
  }

  if (data === "ADM:DELACC") {
    if (!isAdmin(tgId)) return ctx.answerCbQuery("No access", { show_alert: true });
    state.set(tgId, { mode: "ADM_DELACC" });
    await ctx.answerCbQuery();
    return ctx.reply("Format:\nDELACC <password>\nContoh: DELACC abc123", backToMenuKb());
  }

  if (data === "ADM:BAN") {
    if (!isAdmin(tgId)) return ctx.answerCbQuery("No access", { show_alert: true });
    state.set(tgId, { mode: "ADM_BAN" });
    await ctx.answerCbQuery();
    return ctx.reply("Format:\nBAN <tg_id> <alasan_opsional>\nContoh: BAN 123456789 spam", backToMenuKb());
  }

  if (data === "ADM:UNBAN") {
    if (!isAdmin(tgId)) return ctx.answerCbQuery("No access", { show_alert: true });
    state.set(tgId, { mode: "ADM_UNBAN" });
    await ctx.answerCbQuery();
    return ctx.reply("Format:\nUNBAN <tg_id>\nContoh: UNBAN 123456789", backToMenuKb());
  }

  if (data === "ADM:DELUSER") {
    if (!isOwner(tgId)) return ctx.answerCbQuery("Owner only", { show_alert: true });
    state.set(tgId, { mode: "ADM_DELUSER" });
    await ctx.answerCbQuery();
    return ctx.reply("⚠️ OWNER ONLY\nFormat:\nDELUSER <tg_id>\nContoh: DELUSER 123456789", backToMenuKb());
  }

  // PAID TopUp callbacks
  if (IS_PAID && data === "TOPUP_INPUT") {
    state.set(tgId, { mode: "TOPUP_AMOUNT" });
    await ctx.answerCbQuery();
    return ctx.reply("Ketik nominal TopUp (minimal 10000), contoh: 15000", backToMenuKb());
  }

  if (IS_PAID && data.startsWith("TOPUP:")) {
    const amount = Number(data.split(":")[1] || 0);
    if (amount < 10000) return ctx.answerCbQuery("Minimal TopUp Rp 10.000", { show_alert: true });

    const orderId = `TOPUP-${tgId}-${Date.now()}`;
    db.prepare(`INSERT INTO invoices(order_id,tg_id,amount,status) VALUES(?,?,?,'pending')`).run(orderId, tgId, amount);

    const link = pakasirPayLink(orderId, amount);
    await ctx.answerCbQuery("Invoice dibuat.");
    return ctx.editMessageText(
      `✅ Invoice TopUp dibuat\n\nOrder   : ${orderId}\nNominal : ${rupiah(amount)}\n\nBayar:\n${link}\n\nSaldo otomatis masuk setelah status completed.`
    );
  }

  // Trial callback
  if (IS_PAID && data === "TRIAL:GO") {
    if (!TRIAL_ENABLED) return ctx.answerCbQuery("Trial off.", { show_alert: true });
    if (TRIAL_ONCE_PER_USER && trialUsed(tgId)) return ctx.answerCbQuery("Trial sudah pernah dipakai.", { show_alert: true });
    if (trialDailyCount() >= TRIAL_MAX_DAILY) return ctx.answerCbQuery("Kuota trial hari ini habis.", { show_alert: true });
    if (serverActiveCount() >= MAX_ACTIVE) return ctx.answerCbQuery("Server penuh.", { show_alert: true });

    await ctx.answerCbQuery();

    if (TRIAL_PASSWORD_MODE === "manual") {
      state.set(tgId, { mode: "TRIAL_PASSWORD" });
      return ctx.reply(
        `🔑 Masukkan password trial\n\nAturan:\n• 3-32 karakter\n• Tanpa spasi/koma\n• Harus unik\n\nDurasi: ${TRIAL_DAYS} hari`,
        backToMenuKb()
      );
    }

    let password = genTrialPassword();
    for (let i = 0; i < 10; i++) {
      const dup = db.prepare(`SELECT 1 FROM accounts WHERE password=? AND status='active' LIMIT 1`).get(password);
      if (!dup) break;
      password = genTrialPassword();
    }

    try {
      await zivpnAddPassword(password);
      const expiredIso = addDaysIsoFrom(nowIso(), TRIAL_DAYS);
      db.prepare(`INSERT INTO accounts(tg_id,password,expired_at,status,is_trial) VALUES(?,?,?,'active',1)`)
        .run(tgId, password, expiredIso);

      markTrialUsed(tgId);

      return ctx.reply(
        `✅ Trial Berhasil Dibuat\n\nDomain   : ${HOST}\nPassword : ${password}\nExpired  : ${fmtWIB(expiredIso)}`,
        MAIN_KB(ctx)
      );
    } catch (e) {
      const msg = (e.message || "").toString();
      return ctx.reply(`Gagal membuat trial: ${msg}`, MAIN_KB(ctx));
    }
  }

  // Purchase flow
  if (data === "SRV:1") {
    const active = serverActiveCount();
    if (active >= MAX_ACTIVE) return ctx.answerCbQuery("Server penuh.", { show_alert: true });

    const p1 = getPriceByDays(1), p14 = getPriceByDays(14), p30 = getPriceByDays(30);
    const line = (d, p) => IS_PAID ? `${d} Hari : ${rupiah(p)}` : `${d} Hari : GRATIS`;

    await ctx.answerCbQuery();
    return ctx.reply(
      `🛒 Pilih Paket\n\n${line(1, p1)}\n${line(14, p14)}\n${line(30, p30)}\n\nHost: ${HOST}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("1 Hari", "PKG:1"), Markup.button.callback("14 Hari", "PKG:14"), Markup.button.callback("30 Hari", "PKG:30")],
        [Markup.button.callback("🔙 Kembali", "BACK_MENU")]
      ])
    );
  }

  if (data.startsWith("PKG:")) {
    const days = Number(data.split(":")[1] || 0);
    if (![1, 14, 30].includes(days)) return ctx.answerCbQuery("Paket tidak valid.", { show_alert: true });

    const price = getPriceByDays(days);
    state.set(tgId, { mode: "BUY_PASSWORD", days, price });
    await ctx.answerCbQuery("Masukkan password.");
    return ctx.reply(
      `🔑 Masukkan password akun\n\nAturan:\n• 3-32 karakter\n• Tanpa spasi/koma\n• Harus unik\n\nPaket: ${days} hari`,
      backToMenuKb()
    );
  }

  if (data.startsWith("RENEW_PICK:")) {
    const id = Number(data.split(":")[1] || 0);
    const acc = db.prepare(`SELECT id,password,expired_at,status FROM accounts WHERE id=? AND tg_id=?`).get(id, tgId);
    if (!acc || acc.status !== "active") return ctx.answerCbQuery("Akun tidak valid.", { show_alert: true });

    state.set(tgId, { mode: "RENEW_DAYS", accountId: id });
    await ctx.answerCbQuery();

    const line = (d, p) => IS_PAID ? `+${d} Hari (${rupiah(p)})` : `+${d} Hari (GRATIS)`;

    return ctx.reply(
      `♻️ Perpanjang Akun\n\nPassword : ${acc.password}\nExpired   : ${fmtWIB(acc.expired_at)}\n\nPilih paket:`,
      Markup.inlineKeyboard([
        [Markup.button.callback(line(1, getPriceByDays(1)), "RENEW_DAYS:1")],
        [Markup.button.callback(line(14, getPriceByDays(14)), "RENEW_DAYS:14")],
        [Markup.button.callback(line(30, getPriceByDays(30)), "RENEW_DAYS:30")],
        [Markup.button.callback("🔙 Kembali", "BACK_MENU")]
      ])
    );
  }

  if (data.startsWith("RENEW_DAYS:")) {
    const st = state.get(tgId);
    if (!st || st.mode !== "RENEW_DAYS") return ctx.answerCbQuery("Session habis.", { show_alert: true });

    const days = Number(data.split(":")[1] || 0);
    if (![1, 14, 30].includes(days)) return ctx.answerCbQuery("Paket tidak valid.", { show_alert: true });

    const price = getPriceByDays(days);
    const acc = db.prepare(`SELECT id,password,expired_at,status FROM accounts WHERE id=? AND tg_id=?`).get(st.accountId, tgId);
    if (!acc || acc.status !== "active") { state.delete(tgId); return ctx.answerCbQuery("Akun tidak valid.", { show_alert: true }); }

    if (IS_PAID) {
      const saldo = getSaldo(tgId);
      if (saldo < price) { state.delete(tgId); await ctx.answerCbQuery(); return ctx.reply("Saldo tidak cukup. Silakan TopUp.", MAIN_KB(ctx)); }
      if (!debitSaldo(tgId, price)) { state.delete(tgId); return ctx.answerCbQuery("Saldo tidak cukup.", { show_alert: true }); }
    }

    const base = new Date(acc.expired_at) > new Date() ? acc.expired_at : nowIso();
    const newExpired = addDaysIsoFrom(base, days);
    db.prepare(`UPDATE accounts SET expired_at=? WHERE id=? AND tg_id=?`).run(newExpired, acc.id, tgId);

    state.delete(tgId);
    await ctx.answerCbQuery("Berhasil.");
    return ctx.reply(`✅ Perpanjang Berhasil\n\nDomain   : ${HOST}\nPassword : ${acc.password}\nExpired  : ${fmtWIB(newExpired)}`, MAIN_KB(ctx));
  }

  return ctx.answerCbQuery("OK");
});

// ===== Text handler =====
bot.on("text", async (ctx, next) => {
  const tgId = ctx.from.id;
  const st = state.get(tgId);
  if (!st) return next();

  const input = (ctx.message.text || "").trim();

  // Topup manual
  if (IS_PAID && st.mode === "TOPUP_AMOUNT") {
    const amount = Number(input.replace(/[^\d]/g, ""));
    if (!Number.isFinite(amount) || amount < 10000) return ctx.reply("Minimal 10.000. Contoh: 15000", backToMenuKb());

    const orderId = `TOPUP-${tgId}-${Date.now()}`;
    db.prepare(`INSERT INTO invoices(order_id,tg_id,amount,status) VALUES(?,?,?,'pending')`).run(orderId, tgId, amount);

    state.delete(tgId);
    return ctx.reply(`✅ Invoice dibuat\nOrder: ${orderId}\nNominal: ${rupiah(amount)}\n\nBayar:\n${pakasirPayLink(orderId, amount)}`, MAIN_KB(ctx));
  }

  // Trial password manual
  if (IS_PAID && st.mode === "TRIAL_PASSWORD") {
    if (!TRIAL_ENABLED) { state.delete(tgId); return ctx.reply("Trial off.", MAIN_KB(ctx)); }
    if (TRIAL_ONCE_PER_USER && trialUsed(tgId)) { state.delete(tgId); return ctx.reply("Trial sudah pernah dipakai.", MAIN_KB(ctx)); }
    if (trialDailyCount() >= TRIAL_MAX_DAILY) { state.delete(tgId); return ctx.reply("Kuota trial hari ini habis.", MAIN_KB(ctx)); }
    if (serverActiveCount() >= MAX_ACTIVE) { state.delete(tgId); return ctx.reply("Server penuh.", MAIN_KB(ctx)); }

    const password = input;
    if (!validPassword(password)) return ctx.reply("Password tidak valid (3-32, tanpa spasi/koma).", backToMenuKb());

    const dup = db.prepare(`SELECT 1 FROM accounts WHERE password=? AND status='active' LIMIT 1`).get(password);
    if (dup) return ctx.reply("Password sudah dipakai. Gunakan password lain.", backToMenuKb());

    try {
      await zivpnAddPassword(password);
      const expiredIso = addDaysIsoFrom(nowIso(), TRIAL_DAYS);
      db.prepare(`INSERT INTO accounts(tg_id,password,expired_at,status,is_trial) VALUES(?,?,?,'active',1)`).run(tgId, password, expiredIso);
      markTrialUsed(tgId);
      state.delete(tgId);
      return ctx.reply(`✅ Trial Berhasil Dibuat\n\nDomain   : ${HOST}\nPassword : ${password}\nExpired  : ${fmtWIB(expiredIso)}`, MAIN_KB(ctx));
    } catch (e) {
      state.delete(tgId);
      return ctx.reply(`Gagal membuat trial: ${(e.message||"").toString()}`, MAIN_KB(ctx));
    }
  }

  // BUY password flow
  if (st.mode === "BUY_PASSWORD") {
    const { days, price } = st;
    const password = input;

    if (!validPassword(password)) return ctx.reply("Password tidak valid (3-32, tanpa spasi/koma).", backToMenuKb());

    const dup = db.prepare(`SELECT 1 FROM accounts WHERE password=? AND status='active' LIMIT 1`).get(password);
    if (dup) return ctx.reply("Password sudah dipakai. Gunakan password lain.", backToMenuKb());

    const active = serverActiveCount();
    if (active >= MAX_ACTIVE) { state.delete(tgId); return ctx.reply("Server penuh. Coba lagi nanti.", MAIN_KB(ctx)); }

    if (IS_PAID) {
      const saldo = getSaldo(tgId);
      if (saldo < price) { state.delete(tgId); return ctx.reply("Saldo tidak cukup. Silakan TopUp.", MAIN_KB(ctx)); }
      if (!debitSaldo(tgId, price)) { state.delete(tgId); return ctx.reply("Saldo tidak cukup.", MAIN_KB(ctx)); }
    }

    try {
      await zivpnAddPassword(password);
      const expiredIso = addDaysIsoFrom(nowIso(), days);
      db.prepare(`INSERT INTO accounts(tg_id,password,expired_at,status,is_trial) VALUES(?,?,?,'active',0)`).run(tgId, password, expiredIso);
      state.delete(tgId);
      return ctx.reply(`✅ Akun Berhasil Dibuat\n\nDomain   : ${HOST}\nPassword : ${password}\nExpired  : ${fmtWIB(expiredIso)}`, MAIN_KB(ctx));
    } catch (e) {
      if (IS_PAID) addSaldo(tgId, price);
      state.delete(tgId);
      const msg = (e.message || "").toString();
      if (msg.includes("ERR_EXISTS")) return ctx.reply("Password sudah dipakai (server). Pakai yang lain.", MAIN_KB(ctx));
      return ctx.reply(`Gagal membuat akun: ${msg}`, MAIN_KB(ctx));
    }
  }

  // ===== Admin text flows =====
  if (st.mode === "ADM_USERINFO") {
    if (!isAdmin(tgId)) { state.delete(tgId); return ctx.reply("No access", MAIN_KB(ctx)); }
    const uid = Number(input.replace(/[^\d]/g, ""));
    const u = db.prepare(`SELECT tg_id, saldo, role, created_at FROM users WHERE tg_id=?`).get(uid);
    const banned = isBanned(uid);
    const accs = db.prepare(`SELECT password, expired_at, status, COALESCE(is_trial,0) AS is_trial FROM accounts WHERE tg_id=? ORDER BY id DESC LIMIT 10`).all(uid);

    state.delete(tgId);
    if (!u) return ctx.reply("User tidak ditemukan di DB.", MAIN_KB(ctx));

    let msg =
`👤 USER INFO
ID     : ${u.tg_id}
Saldo  : ${IS_PAID ? rupiah(u.saldo) : "-"}
Banned : ${banned ? "YES" : "NO"}
Since  : ${u.created_at}

Akun (10 terakhir):
`;
    if (!accs.length) msg += "(kosong)";
    else {
      for (const a of accs) {
        msg += `\n- ${a.password} | ${a.status}${a.is_trial ? " (TRIAL)" : ""} | exp ${fmtWIB(a.expired_at)}`;
      }
    }
    return ctx.reply(msg, MAIN_KB(ctx));
  }

  if (st.mode === "ADM_CREATE") {
    if (!isAdmin(tgId)) { state.delete(tgId); return ctx.reply("No access", MAIN_KB(ctx)); }
    // CREATE <tg_id> <days> <password>
    const m = input.split(/\s+/);
    if (m[0]?.toUpperCase() !== "CREATE" || m.length < 4) return ctx.reply("Format:\nCREATE <tg_id> <days> <password>", backToMenuKb());

    const uid = Number(m[1]);
    const days = Number(m[2]);
    const password = m.slice(3).join(" ").trim();

    if (!Number.isFinite(uid) || uid <= 0) return ctx.reply("tg_id tidak valid", backToMenuKb());
    if (![1,14,30].includes(days)) return ctx.reply("Days harus 1 / 14 / 30", backToMenuKb());
    if (!validPassword(password)) return ctx.reply("Password tidak valid.", backToMenuKb());

    const dup = db.prepare(`SELECT 1 FROM accounts WHERE password=? AND status='active' LIMIT 1`).get(password);
    if (dup) return ctx.reply("Password sudah dipakai.", backToMenuKb());

    if (serverActiveCount() >= MAX_ACTIVE && !isOwner(tgId)) {
      state.delete(tgId);
      return ctx.reply("Server penuh (owner bisa bypass).", MAIN_KB(ctx));
    }

    try {
      await zivpnAddPassword(password);
      const expiredIso = addDaysIsoFrom(nowIso(), days);
      upsertUser(uid);
      db.prepare(`INSERT INTO accounts(tg_id,password,expired_at,status,is_trial) VALUES(?,?,?,'active',0)`).run(uid, password, expiredIso);
      state.delete(tgId);
      return ctx.reply(`✅ Admin create sukses\nUser: ${uid}\nDomain: ${HOST}\nPassword: ${password}\nExpired: ${fmtWIB(expiredIso)}`, MAIN_KB(ctx));
    } catch (e) {
      state.delete(tgId);
      return ctx.reply(`Gagal: ${(e.message||"").toString()}`, MAIN_KB(ctx));
    }
  }

  if (st.mode === "ADM_EXTEND") {
    if (!isAdmin(tgId)) { state.delete(tgId); return ctx.reply("No access", MAIN_KB(ctx)); }
    // EXTEND <password> <days>
    const m = input.split(/\s+/);
    if (m[0]?.toUpperCase() !== "EXTEND" || m.length < 3) return ctx.reply("Format:\nEXTEND <password> <days>", backToMenuKb());

    const password = m[1];
    const days = Number(m[2]);
    if (![1,14,30].includes(days)) return ctx.reply("Days harus 1/14/30", backToMenuKb());

    const acc = db.prepare(`SELECT id, tg_id, expired_at, status FROM accounts WHERE password=? ORDER BY id DESC LIMIT 1`).get(password);
    if (!acc || acc.status !== "active") { state.delete(tgId); return ctx.reply("Akun tidak ditemukan / tidak aktif.", MAIN_KB(ctx)); }

    const base = new Date(acc.expired_at) > new Date() ? acc.expired_at : nowIso();
    const newExpired = addDaysIsoFrom(base, days);
    db.prepare(`UPDATE accounts SET expired_at=? WHERE id=?`).run(newExpired, acc.id);

    state.delete(tgId);
    return ctx.reply(`✅ Extend sukses\nPassword: ${password}\nExpired: ${fmtWIB(newExpired)}`, MAIN_KB(ctx));
  }

  if (st.mode === "ADM_DELACC") {
    if (!isAdmin(tgId)) { state.delete(tgId); return ctx.reply("No access", MAIN_KB(ctx)); }
    // DELACC <password>
    const m = input.split(/\s+/);
    if (m[0]?.toUpperCase() !== "DELACC" || m.length < 2) return ctx.reply("Format:\nDELACC <password>", backToMenuKb());
    const password = m[1];

    const acc = db.prepare(`SELECT id, status FROM accounts WHERE password=? ORDER BY id DESC LIMIT 1`).get(password);
    if (!acc) { state.delete(tgId); return ctx.reply("Akun tidak ditemukan.", MAIN_KB(ctx)); }

    try { await zivpnDelPassword(password); } catch {}
    db.prepare(`UPDATE accounts SET status='expired', expired_at=? WHERE id=?`).run(nowIso(), acc.id);

    state.delete(tgId);
    return ctx.reply(`🗑 Akun dihapus (revoked)\nPassword: ${password}`, MAIN_KB(ctx));
  }

  if (st.mode === "ADM_BAN") {
    if (!isAdmin(tgId)) { state.delete(tgId); return ctx.reply("No access", MAIN_KB(ctx)); }
    // BAN <tg_id> <reason?>
    const m = input.split(/\s+/);
    if (m[0]?.toUpperCase() !== "BAN" || m.length < 2) return ctx.reply("Format:\nBAN <tg_id> <alasan_opsional>", backToMenuKb());
    const uid = Number(m[1]);
    const reason = m.slice(2).join(" ").trim();

    banUser(uid, reason);

    // revoke all active accounts
    const rows = db.prepare(`SELECT id,password FROM accounts WHERE tg_id=? AND status='active'`).all(uid);
    for (const r of rows) {
      try { await zivpnDelPassword(r.password); } catch {}
      db.prepare(`UPDATE accounts SET status='expired', expired_at=? WHERE id=?`).run(nowIso(), r.id);
    }

    state.delete(tgId);
    return ctx.reply(`⛔ User diban: ${uid}\nRevoke akun aktif: ${rows.length}`, MAIN_KB(ctx));
  }

  if (st.mode === "ADM_UNBAN") {
    if (!isAdmin(tgId)) { state.delete(tgId); return ctx.reply("No access", MAIN_KB(ctx)); }
    const m = input.split(/\s+/);
    if (m[0]?.toUpperCase() !== "UNBAN" || m.length < 2) return ctx.reply("Format:\nUNBAN <tg_id>", backToMenuKb());
    const uid = Number(m[1]);
    unbanUser(uid);
    state.delete(tgId);
    return ctx.reply(`✅ Unban sukses: ${uid}`, MAIN_KB(ctx));
  }

  if (st.mode === "ADM_DELUSER") {
    if (!isOwner(tgId)) { state.delete(tgId); return ctx.reply("Owner only", MAIN_KB(ctx)); }
    const m = input.split(/\s+/);
    if (m[0]?.toUpperCase() !== "DELUSER" || m.length < 2) return ctx.reply("Format:\nDELUSER <tg_id>", backToMenuKb());
    const uid = Number(m[1]);

    const rows = db.prepare(`SELECT id,password FROM accounts WHERE tg_id=? AND status='active'`).all(uid);
    for (const r of rows) {
      try { await zivpnDelPassword(r.password); } catch {}
    }

    db.prepare(`DELETE FROM accounts WHERE tg_id=?`).run(uid);
    db.prepare(`DELETE FROM invoices WHERE tg_id=?`).run(uid);
    db.prepare(`DELETE FROM trials WHERE tg_id=?`).run(uid);
    db.prepare(`DELETE FROM allowlist WHERE tg_id=?`).run(uid);
    db.prepare(`DELETE FROM bans WHERE tg_id=?`).run(uid);
    db.prepare(`DELETE FROM users WHERE tg_id=?`).run(uid);

    state.delete(tgId);
    return ctx.reply(`🧹 Delete user sukses: ${uid}\nRevoke akun aktif: ${rows.length}`, MAIN_KB(ctx));
  }

  return next();
});

// ===== Pakasir webhook server (paid only) =====
if (IS_PAID) {
  const app = express();
  app.use(express.json());

  app.post(WEBHOOK_PATH, async (req, res) => {
    try {
      const { order_id, amount, status } = req.body || {};
      const orderId = String(order_id || "").trim();
      const amt = Number(amount || 0);
      const st = String(status || "").toLowerCase();

      if (!orderId || amt <= 0) return res.status(400).json({ ok: false });
      if (st !== "completed") return res.json({ ok: true, ignored: true });

      const detail = await pakasirVerify(orderId, amt);
      const tx = detail.transaction || {};
      if (String(tx.status || "").toLowerCase() !== "completed") {
        return res.status(400).json({ ok: false, reason: "not_completed_in_detail" });
      }

      const inv = db.prepare(`SELECT order_id,tg_id,amount,status FROM invoices WHERE order_id=?`).get(orderId);
      if (!inv) return res.json({ ok: true, ignored: true });
      if (inv.status === "paid") return res.json({ ok: true, already: true });

      db.prepare(`UPDATE invoices SET status='paid', paid_at=datetime('now') WHERE order_id=?`).run(orderId);
      addSaldo(inv.tg_id, inv.amount);

      await bot.telegram.sendMessage(inv.tg_id, `✅ TopUp berhasil\nOrder: ${orderId}\nNominal: ${rupiah(inv.amount)}`);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.listen(PORT, "127.0.0.1", () => console.log("Webhook on 127.0.0.1:" + PORT));
}

// ===== Auto expire cleanup =====
cron.schedule("*/5 * * * *", async () => {
  try {
    const expired = db.prepare(`SELECT id, password FROM accounts WHERE status='active' AND expired_at <= ?`).all(nowIso());
    for (const a of expired) {
      try { await zivpnDelPassword(a.password); } catch { continue; }
      db.prepare(`UPDATE accounts SET status='expired' WHERE id=?`).run(a.id);
    }
  } catch {}
});

bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
