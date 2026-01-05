const { Telegraf, Markup } = require("telegraf");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const axios = require("axios");
const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// ===== ENV =====
const MODE = (process.env.MODE || "paid").toLowerCase();
const IS_PAID = MODE === "paid";

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_ID || 0);
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean)
  .map(s => Number(s)).filter(n => Number.isFinite(n) && n > 0);

const DB_PATH = process.env.DB_PATH || "/var/lib/opal-daemon/app.db";

const PAKASIR_SLUG = process.env.PAKASIR_SLUG || "";
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY || "";
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/pakasir/webhook";
const PORT = Number(process.env.PORT || 9000);
const WEBHOOK_TOKEN = (process.env.WEBHOOK_TOKEN || "").trim();

// Trial (paid)
const TRIAL_ENABLED = (process.env.TRIAL_ENABLED || "true").toLowerCase() === "true";
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 1);
const TRIAL_ONCE_PER_USER = (process.env.TRIAL_ONCE_PER_USER || "true").toLowerCase() === "true";
const TRIAL_MAX_DAILY = Number(process.env.TRIAL_MAX_DAILY || 50);
const TRIAL_PASSWORD_MODE = (process.env.TRIAL_PASSWORD_MODE || "auto").toLowerCase(); // auto/manual
const TRIAL_PREFIX = (process.env.TRIAL_PREFIX || "TR").toUpperCase();

if (!BOT_TOKEN) { console.error("Missing BOT_TOKEN"); process.exit(1); }
if (IS_PAID && (!PAKASIR_SLUG || !PAKASIR_API_KEY)) {
  console.error("MODE=paid but missing PAKASIR_SLUG/PAKASIR_API_KEY");
  process.exit(1);
}

// ===== Helpers =====
function isOwner(tgId) { return OWNER_ID && Number(tgId) === Number(OWNER_ID); }
function isAdmin(tgId) { return isOwner(tgId) || ADMIN_IDS.includes(Number(tgId)); }

function rupiah(n) {
  const x = Number(n || 0);
  return "Rp" + x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
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
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} WIB`;
}
function validPassword(p) {
  return typeof p === "string" && p.length >= 3 && p.length <= 32 && !/[,\s"]/.test(p);
}

// ===== Load servers =====
function loadServers() {
  const p = path.join(__dirname, "config", "servers.json");

  // ✅ jangan crash kalau file belum ada
  if (!fs.existsSync(p)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(raw)) return [];
    // enabled default true kalau field enabled tidak ada
    return raw.filter(s => s && s.enabled !== false);
  } catch (e) {
    console.error("servers.json invalid:", e.message);
    return [];
  }
}

function getServer(code) {
  return loadServers().find(s => s.code === code);
}


// ===== ZiVPN integration =====
function zivpnAddPassword(password) {
  return new Promise((resolve, reject) => {
    execFile("/usr/local/bin/zivpn-passwd-manager", ["add", password], (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message || "").toString()));
      resolve((stdout || "").toString().trim());
    });
  });
}
function zivpnDelPassword(password) {
  return new Promise((resolve, reject) => {
    execFile("/usr/local/bin/zivpn-passwd-manager", ["del", password], (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message || "").toString()));
      resolve((stdout || "").toString().trim());
    });
  });
}

// ===== DB =====
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  saldo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  order_id TEXT PRIMARY KEY,
  tg_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  qris_string TEXT,
  qris_expired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  server_code TEXT,
  host TEXT,
  password TEXT NOT NULL,
  is_trial INTEGER NOT NULL DEFAULT 0,
  expired_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trials (
  tg_id INTEGER PRIMARY KEY,
  used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_pass ON accounts(password, status);
CREATE INDEX IF NOT EXISTS idx_accounts_tg ON accounts(tg_id);
`);

function upsertUser(tgId) {
  db.prepare(`INSERT OR IGNORE INTO users(tg_id) VALUES(?)`).run(tgId);
  return db.prepare(`SELECT tg_id, saldo FROM users WHERE tg_id=?`).get(tgId);
}
function getSaldo(tgId) {
  return db.prepare(`SELECT saldo FROM users WHERE tg_id=?`).get(tgId)?.saldo || 0;
}
function addSaldo(tgId, amount) {
  db.prepare(`UPDATE users SET saldo = saldo + ? WHERE tg_id=?`).run(amount, tgId);
}
function debitSaldo(tgId, amount) {
  const s = getSaldo(tgId);
  if (s < amount) return false;
  db.prepare(`UPDATE users SET saldo = saldo - ? WHERE tg_id=?`).run(amount, tgId);
  return true;
}

function activeCountByServer(code) {
  const now = nowIso();
  return db.prepare(`
    SELECT COUNT(*) AS c FROM accounts
    WHERE status='active' AND server_code=? AND expired_at > ?
  `).get(code, now)?.c || 0;
}

function formatServerList() {
  const servers = loadServers();
  let out = "";
  for (const s of servers) {
    const used = activeCountByServer(s.code);
    const full = used >= Number(s.capacity || 0);
    out +=
`🌐 ${s.name}
💰 Harga per hari: Rp${s.prices?.["1"] ?? 0}
📅 Harga per 30 hari: Rp${s.prices?.["30"] ?? 0}
📊 Quota: ${s.quota_gb ?? 0}GB
🔐 Limit IP: ${s.ip_limit ?? 1} IP
👥 Akun Terpakai: ${used}/${s.capacity}
${full ? "⚠️ Server Penuh" : "✅ Tersedia"}

`;
  }
  return out.trim();
}

function serverButtons() {
  const servers = loadServers();
  const rows = [];
  for (let i = 0; i < servers.length; i += 2) {
    const a = servers[i];
    const b = servers[i+1];
    const row = [Markup.button.callback(a.code, `SRV:${a.code}`)];
    if (b) row.push(Markup.button.callback(b.code, `SRV:${b.code}`));
    rows.push(row);
  }
  rows.push([Markup.button.callback("🏠 Menu Utama", "BACK_MENU")]);
  return Markup.inlineKeyboard(rows);
}

// ===== Trial helpers =====
function trialUsed(tgId) {
  return !!db.prepare(`SELECT 1 FROM trials WHERE tg_id=?`).get(tgId);
}
function trialDailyCount() {
  return db.prepare(`SELECT COUNT(*) AS c FROM trials WHERE date(used_at,'localtime')=date('now','localtime')`).get()?.c || 0;
}
function markTrialUsed(tgId) {
  db.prepare(`INSERT OR IGNORE INTO trials(tg_id) VALUES(?)`).run(tgId);
}
function genTrialPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return `${TRIAL_PREFIX}-${s}`;
}

// ===== Pakasir helpers =====
// NOTE: struktur response Pakasir bisa beda-beda. Kalau error, cek log console.
async function pakasirCreateQris(orderId, amount) {
  const url = "https://app.pakasir.com/api/transactioncreate/qris";
  const res = await axios.post(url, {
    project: PAKASIR_SLUG,
    order_id: orderId,
    amount,
    api_key: PAKASIR_API_KEY
  }, { timeout: 15000 });
  return res.data;
}

async function pakasirVerifyDetail(orderId, amount) {
  const url = "https://app.pakasir.com/api/transactiondetail";
  const res = await axios.get(url, {
    params: { project: PAKASIR_SLUG, amount, order_id: orderId, api_key: PAKASIR_API_KEY },
    timeout: 15000
  });
  return res.data;
}

function pickQrisString(apiData) {
  return (
    apiData?.payment?.payment_number ||
    apiData?.data?.payment?.payment_number ||
    apiData?.payment_number ||
    ""
  );
}
function pickExpired(apiData) {
  return (
    apiData?.payment?.expired_at ||
    apiData?.data?.payment?.expired_at ||
    apiData?.expired_at ||
    ""
  );
}
function pickStatusFromDetail(detail) {
  // coba berbagai kemungkinan field
  const tx = detail?.transaction || detail?.data?.transaction || detail;
  const s = (tx?.status || tx?.data?.status || "").toString().toLowerCase();
  return s;
}

async function sendQris(ctx, orderId, amount, qrisString, expiredAt) {
  const png = await QRCode.toBuffer(qrisString, { type: "png", width: 420 });
  const caption =
`✅ Silakan bayar via QRIS

Order   : ${orderId}
Nominal : ${rupiah(amount)}
Expired : ${expiredAt || "-"}

Setelah bayar, saldo masuk otomatis.`;
  await ctx.replyWithPhoto({ source: png }, { caption });
}

// ===== Bot =====
const bot = new Telegraf(BOT_TOKEN);
const state = new Map(); // tgId -> session

// Keyboard utama
function mainKb(ctx) {
  const base = [
    ["➕ Buat Akun", "♻️ Perpanjang Akun"],
    ...(IS_PAID ? [["⏳ Trial Akun", "💰 TopUp Saldo"]] : []),
    ["📌 Akun Saya", "📞 Bantuan"]
  ];
  if (ctx && isAdmin(ctx.from.id)) base.push(["⚙️ Admin Panel"]);
  return Markup.keyboard(base).resize();
}

async function showStart(ctx) {
  const u = upsertUser(ctx.from.id);
  const header =
`╭─⚡ ZIVPN UDP PREMIUM ⚡─╮
│ Bot VPN UDP dengan sistem otomatis
│ Akses internet cepat & aman
╰────────────────────────╯`;

  const text =
`${header}

👋 Hai, ${ctx.from.first_name}!
ID: ${u.tg_id}
Saldo: ${IS_PAID ? rupiah(u.saldo) : "Rp 0"}
Mode: ${IS_PAID ? "PAID" : "FREE"}

Pilih menu 👇`;

  return ctx.reply(text, mainKb(ctx));
}

bot.start(showStart);
bot.command("start", showStart);

// Bantuan
bot.hears("📞 Bantuan", async (ctx) => {
  return ctx.reply(
`📞 Bantuan

• Buat Akun: pilih server → pilih paket → masukkan password unik
• Password: 3-32 karakter, tanpa spasi/koma, harus unik
${IS_PAID ? "• TopUp minimal Rp 10.000\n• QRIS akan muncul otomatis\n" : ""}

Jika ada kendala, hubungi admin.`,
    mainKb(ctx)
  );
});

// Buat akun → list server
bot.hears("➕ Buat Akun", async (ctx) => {
  upsertUser(ctx.from.id);
  return ctx.reply(formatServerList(), serverButtons());
});

// Callback handling
bot.on("callback_query", async (ctx) => {
  const tgId = ctx.from.id;
  upsertUser(tgId);
  const data = ctx.callbackQuery.data || "";

  if (data === "BACK_MENU") {
    await ctx.answerCbQuery();
    return showStart(ctx);
  }

  // pilih server
  if (data.startsWith("SRV:")) {
    const code = data.split(":")[1];
    const s = getServer(code);
    if (!s) { await ctx.answerCbQuery("Server tidak ditemukan", { show_alert:true }); return; }

    const used = activeCountByServer(code);
    if (used >= s.capacity) { await ctx.answerCbQuery("Server penuh", { show_alert:true }); return; }

    state.set(tgId, { mode: "PICK_PACKAGE", server_code: code });
    await ctx.answerCbQuery();

    const paketText =
`✅ PILIH SERVER

🌐 ${s.name}
💰 Harga per hari: Rp${s.prices["1"]}
📅 Harga per 30 hari: Rp${s.prices["30"]}
📊 Quota: ${s.quota_gb}GB
🔐 Limit IP: ${s.ip_limit} IP
👥 Akun Terpakai: ${used}/${s.capacity}

🛒 Pilih Paket:
Host: ${s.host}`;

    return ctx.reply(
      paketText,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("1 Hari", "PKG:1"),
          Markup.button.callback("14 Hari", "PKG:14"),
          Markup.button.callback("30 Hari", "PKG:30")
        ],
        [Markup.button.callback("🔙 Kembali ke List Server", "BACK_SERVERS")],
        [Markup.button.callback("🏠 Menu Utama", "BACK_MENU")]
      ])
    );
  }

  if (data === "BACK_SERVERS") {
    await ctx.answerCbQuery();
    return ctx.reply(formatServerList(), serverButtons());
  }

  // pilih paket (days)
  if (data.startsWith("PKG:")) {
    const days = Number(data.split(":")[1] || 0);
    if (![1,14,30].includes(days)) { await ctx.answerCbQuery("Paket tidak valid", { show_alert:true }); return; }

    const st = state.get(tgId);
    if (!st || st.mode !== "PICK_PACKAGE") { await ctx.answerCbQuery("Pilih server dulu", { show_alert:true }); return; }

    const s = getServer(st.server_code);
    if (!s) { await ctx.answerCbQuery("Server tidak ditemukan", { show_alert:true }); return; }

    const price = IS_PAID ? Number(s.prices[String(days)] || 0) : 0;

    state.set(tgId, { mode: "BUY_PASSWORD", server_code: s.code, days, price });
    await ctx.answerCbQuery("Masukkan password");

    return ctx.reply(
`🔑 Masukkan password akun

Aturan:
• 3-32 karakter
• Tanpa spasi/koma
• Harus unik

Paket: ${days} hari`,
      Markup.keyboard([["🏠 Menu Utama"]]).resize()
    );
  }

  // Topup preset
  if (IS_PAID && data.startsWith("TOPUP:")) {
    const amount = Number(data.split(":")[1] || 0);
    if (amount < 10000) { await ctx.answerCbQuery("Minimal 10.000", { show_alert:true }); return; }

    const orderId = `TOPUP-${tgId}-${Date.now()}`;
    db.prepare(`INSERT INTO invoices(order_id,tg_id,amount,status) VALUES(?,?,?,'pending')`).run(orderId, tgId, amount);

    await ctx.answerCbQuery("Membuat QRIS...");

    try {
      const apiData = await pakasirCreateQris(orderId, amount);
      const qrisString = pickQrisString(apiData);
      const expiredAt = pickExpired(apiData);

      if (!qrisString) {
        return ctx.reply("Gagal ambil QRIS. Cek PAKASIR_SLUG/API_KEY. Lihat log service untuk detail.", mainKb(ctx));
      }

      db.prepare(`UPDATE invoices SET qris_string=?, qris_expired_at=? WHERE order_id=?`)
        .run(qrisString, expiredAt, orderId);

      await sendQris(ctx, orderId, amount, qrisString, expiredAt);
      return;
    } catch (e) {
      return ctx.reply(`Gagal membuat QRIS: ${(e.message||"").toString()}`, mainKb(ctx));
    }
  }

  // Admin panel (ringan)
  if (data === "ADM:STATS") {
    if (!isAdmin(tgId)) { await ctx.answerCbQuery("No access", { show_alert:true }); return; }
    await ctx.answerCbQuery();
    const users = db.prepare(`SELECT COUNT(*) c FROM users`).get().c;
    const active = db.prepare(`SELECT COUNT(*) c FROM accounts WHERE status='active'`).get().c;
    const expired = db.prepare(`SELECT COUNT(*) c FROM accounts WHERE status='expired'`).get().c;
    return ctx.reply(`📊 Statistik\nUsers: ${users}\nAkun aktif: ${active}\nAkun expired: ${expired}`, mainKb(ctx));
  }

  await ctx.answerCbQuery("OK");
});

// Menu tombol text
bot.hears("🏠 Menu Utama", showStart);

bot.hears("💰 TopUp Saldo", async (ctx) => {
  if (!IS_PAID) return ctx.reply("TopUp hanya tersedia di MODE=paid.", mainKb(ctx));
  upsertUser(ctx.from.id);

  return ctx.reply(
`💰 TopUp Saldo
Minimal: Rp 10.000

Pilih nominal:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("10.000", "TOPUP:10000"), Markup.button.callback("20.000", "TOPUP:20000")],
      [Markup.button.callback("50.000", "TOPUP:50000"), Markup.button.callback("100.000", "TOPUP:100000")],
      [Markup.button.callback("✍️ Input Nominal", "TOPUP_INPUT")],
      [Markup.button.callback("🏠 Menu Utama", "BACK_MENU")]
    ])
  );
});

bot.on("callback_query", async (ctx, next) => {
  const data = ctx.callbackQuery.data || "";
  const tgId = ctx.from.id;

  if (data === "TOPUP_INPUT") {
    if (!IS_PAID) return;
    state.set(tgId, { mode: "TOPUP_AMOUNT" });
    await ctx.answerCbQuery();
    return ctx.reply("Ketik nominal topup (minimal 10000). Contoh: 15000", Markup.keyboard([["🏠 Menu Utama"]]).resize());
  }
  if (data === "ADM:PANEL") {
    if (!isAdmin(tgId)) { await ctx.answerCbQuery("No access", { show_alert:true }); return; }
    await ctx.answerCbQuery();
    return ctx.reply("⚙️ Admin Panel", Markup.inlineKeyboard([
      [Markup.button.callback("📊 Statistik", "ADM:STATS")],
      [Markup.button.callback("🏠 Menu Utama", "BACK_MENU")]
    ]));
  }
  return next();
});

bot.hears("⚙️ Admin Panel", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  return ctx.reply("⚙️ Admin Panel", Markup.inlineKeyboard([
    [Markup.button.callback("📊 Statistik", "ADM:STATS")],
    [Markup.button.callback("🏠 Menu Utama", "BACK_MENU")]
  ]));
});

// Trial
bot.hears("⏳ Trial Akun", async (ctx) => {
  if (!IS_PAID) return ctx.reply("Trial hanya tersedia di MODE=paid.", mainKb(ctx));
  upsertUser(ctx.from.id);

  if (!TRIAL_ENABLED) return ctx.reply("Trial sedang off.", mainKb(ctx));
  if (TRIAL_ONCE_PER_USER && trialUsed(ctx.from.id)) return ctx.reply("Anda sudah pernah trial.", mainKb(ctx));
  if (trialDailyCount() >= TRIAL_MAX_DAILY) return ctx.reply("Kuota trial hari ini habis.", mainKb(ctx));

  // trial pakai server pertama (atau bapak bisa bikin server khusus trial)
  const s = loadServers()[0];
  if (!s) return ctx.reply("Server belum dikonfigurasi.", mainKb(ctx));

  const used = activeCountByServer(s.code);
  if (used >= s.capacity) return ctx.reply("Server penuh, trial tidak tersedia.", mainKb(ctx));

  state.set(ctx.from.id, { mode: "TRIAL_PASSWORD", server_code: s.code });

  if (TRIAL_PASSWORD_MODE === "manual") {
    return ctx.reply(
`🔑 Masukkan password trial
Aturan: 3-32, tanpa spasi/koma, unik
Durasi: ${TRIAL_DAYS} hari`,
      Markup.keyboard([["🏠 Menu Utama"]]).resize()
    );
  }

  // auto
  let password = genTrialPassword();
  for (let i=0;i<10;i++) {
    const dup = db.prepare(`SELECT 1 FROM accounts WHERE password=? AND status='active' LIMIT 1`).get(password);
    if (!dup) break;
    password = genTrialPassword();
  }

  try {
    await zivpnAddPassword(password);
    const expired = addDaysIsoFrom(nowIso(), TRIAL_DAYS);

    db.prepare(`
      INSERT INTO accounts(tg_id,server_code,host,password,is_trial,expired_at,status)
      VALUES(?,?,?,?,1,?,'active')
    `).run(ctx.from.id, s.code, s.host, password, expired);

    markTrialUsed(ctx.from.id);
    state.delete(ctx.from.id);

    return ctx.reply(
      `✅ Trial Berhasil Dibuat\n\nDomain   : ${s.host}\nPassword : ${password}\nExpired  : ${fmtWIB(expired)}`,
      mainKb(ctx)
    );
  } catch (e) {
    state.delete(ctx.from.id);
    return ctx.reply(`Gagal trial: ${(e.message||"").toString()}`, mainKb(ctx));
  }
});

// Akun saya
bot.hears("📌 Akun Saya", async (ctx) => {
  upsertUser(ctx.from.id);

  const rows = db.prepare(`
    SELECT host,password,expired_at,status,is_trial
    FROM accounts
    WHERE tg_id=?
    ORDER BY id DESC
    LIMIT 10
  `).all(ctx.from.id);

  if (!rows.length) return ctx.reply("Belum ada akun.", mainKb(ctx));

  let msg = "📌 Akun Anda (10 terakhir)\n\n";
  for (const r of rows) {
    msg +=
`Domain   : ${r.host}
Password : ${r.password}
Expired  : ${fmtWIB(r.expired_at)}
Status   : ${r.status}${r.is_trial ? " (TRIAL)" : ""}

`;
  }
  return ctx.reply(msg.trim(), mainKb(ctx));
});

// Perpanjang (sederhana: user ketik password yang mau diperpanjang)
bot.hears("♻️ Perpanjang Akun", async (ctx) => {
  if (!IS_PAID) return ctx.reply("Perpanjang hanya tersedia di MODE=paid.", mainKb(ctx));
  upsertUser(ctx.from.id);
  state.set(ctx.from.id, { mode: "RENEW_PASSWORD" });
  return ctx.reply("Ketik password akun yang mau diperpanjang:", Markup.keyboard([["🏠 Menu Utama"]]).resize());
});

// Text handler (password / topup input / renew)
bot.on("text", async (ctx, next) => {
  const tgId = ctx.from.id;
  const st = state.get(tgId);
  if (!st) return next();

  const input = (ctx.message.text || "").trim();

  // Topup input manual
  if (IS_PAID && st.mode === "TOPUP_AMOUNT") {
    const amount = Number(input.replace(/[^\d]/g, ""));
    if (!Number.isFinite(amount) || amount < 10000) return ctx.reply("Minimal 10000. Contoh: 15000");

    const orderId = `TOPUP-${tgId}-${Date.now()}`;
    db.prepare(`INSERT INTO invoices(order_id,tg_id,amount,status) VALUES(?,?,?,'pending')`).run(orderId, tgId, amount);

    try {
      const apiData = await pakasirCreateQris(orderId, amount);
      const qrisString = pickQrisString(apiData);
      const expiredAt = pickExpired(apiData);

      if (!qrisString) {
        state.delete(tgId);
        return ctx.reply("Gagal ambil QRIS. Cek konfigurasi Pakasir.", mainKb(ctx));
      }

      db.prepare(`UPDATE invoices SET qris_string=?, qris_expired_at=? WHERE order_id=?`)
        .run(qrisString, expiredAt, orderId);

      state.delete(tgId);
      await sendQris(ctx, orderId, amount, qrisString, expiredAt);
      return;
    } catch (e) {
      state.delete(tgId);
      return ctx.reply(`Gagal membuat QRIS: ${(e.message||"").toString()}`, mainKb(ctx));
    }
  }

  // Trial manual password
  if (IS_PAID && st.mode === "TRIAL_PASSWORD" && TRIAL_PASSWORD_MODE === "manual") {
    const s = getServer(st.server_code);
    if (!s) { state.delete(tgId); return ctx.reply("Server trial tidak ditemukan.", mainKb(ctx)); }

    if (!TRIAL_ENABLED) { state.delete(tgId); return ctx.reply("Trial off.", mainKb(ctx)); }
    if (TRIAL_ONCE_PER_USER && trialUsed(tgId)) { state.delete(tgId); return ctx.reply("Sudah pernah trial.", mainKb(ctx)); }
    if (trialDailyCount() >= TRIAL_MAX_DAILY) { state.delete(tgId); return ctx.reply("Kuota trial habis.", mainKb(ctx)); }

    const password = input;
    if (!validPassword(password)) return ctx.reply("Password tidak valid (3-32, tanpa spasi/koma).");

    const dup = db.prepare(`SELECT 1 FROM accounts WHERE password=? AND status='active' LIMIT 1`).get(password);
    if (dup) return ctx.reply("Password sudah dipakai. Gunakan yang lain.");

    try {
      await zivpnAddPassword(password);
      const expired = addDaysIsoFrom(nowIso(), TRIAL_DAYS);

      db.prepare(`
        INSERT INTO accounts(tg_id,server_code,host,password,is_trial,expired_at,status)
        VALUES(?,?,?,?,1,?,'active')
      `).run(tgId, s.code, s.host, password, expired);

      markTrialUsed(tgId);
      state.delete(tgId);

      return ctx.reply(`✅ Trial Berhasil Dibuat\n\nDomain   : ${s.host}\nPassword : ${password}\nExpired  : ${fmtWIB(expired)}`, mainKb(ctx));
    } catch (e) {
      state.delete(tgId);
      return ctx.reply(`Gagal trial: ${(e.message||"").toString()}`, mainKb(ctx));
    }
  }

  // BUY_PASSWORD create akun
  if (st.mode === "BUY_PASSWORD") {
    const password = input;
    if (!validPassword(password)) return ctx.reply("Password tidak valid (3-32, tanpa spasi/koma).");

    const dup = db.prepare(`SELECT 1 FROM accounts WHERE password=? AND status='active' LIMIT 1`).get(password);
    if (dup) return ctx.reply("Password sudah dipakai. Gunakan password lain.");

    const s = getServer(st.server_code);
    if (!s) { state.delete(tgId); return ctx.reply("Server tidak ditemukan. Ulangi dari Buat Akun.", mainKb(ctx)); }

    const used = activeCountByServer(s.code);
    if (used >= s.capacity) { state.delete(tgId); return ctx.reply("Server penuh. Pilih server lain.", mainKb(ctx)); }

    if (IS_PAID) {
      const saldo = getSaldo(tgId);
      if (saldo < st.price) { state.delete(tgId); return ctx.reply("Saldo tidak cukup. Silakan TopUp.", mainKb(ctx)); }
      if (!debitSaldo(tgId, st.price)) { state.delete(tgId); return ctx.reply("Saldo tidak cukup.", mainKb(ctx)); }
    }

    try {
      await zivpnAddPassword(password);
      const expired = addDaysIsoFrom(nowIso(), st.days);

      db.prepare(`
        INSERT INTO accounts(tg_id,server_code,host,password,is_trial,expired_at,status)
        VALUES(?,?,?,?,0,?,'active')
      `).run(tgId, s.code, s.host, password, expired);

      state.delete(tgId);
      return ctx.reply(`✅ Akun Berhasil Dibuat\n\nDomain   : ${s.host}\nPassword : ${password}\nExpired  : ${fmtWIB(expired)}`, mainKb(ctx));
    } catch (e) {
      if (IS_PAID) addSaldo(tgId, st.price); // refund
      state.delete(tgId);
      return ctx.reply(`Gagal membuat akun: ${(e.message||"").toString()}`, mainKb(ctx));
    }
  }

  // RENEW
  if (IS_PAID && st.mode === "RENEW_PASSWORD") {
    const password = input;
    const acc = db.prepare(`
      SELECT id, server_code, host, password, expired_at, status, is_trial
      FROM accounts
      WHERE tg_id=? AND password=?
      ORDER BY id DESC LIMIT 1
    `).get(tgId, password);

    if (!acc || acc.status !== "active") { state.delete(tgId); return ctx.reply("Akun tidak ditemukan / tidak aktif.", mainKb(ctx)); }
    if (acc.is_trial) { state.delete(tgId); return ctx.reply("Akun trial tidak bisa diperpanjang.", mainKb(ctx)); }

    // tanya paket
    state.set(tgId, { mode: "RENEW_DAYS", account_id: acc.id });
    return ctx.reply(
`Pilih paket perpanjang:
Password: ${acc.password}
Expired : ${fmtWIB(acc.expired_at)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("1 Hari", "RENEW:1"), Markup.button.callback("14 Hari", "RENEW:14"), Markup.button.callback("30 Hari", "RENEW:30")],
        [Markup.button.callback("🏠 Menu Utama", "BACK_MENU")]
      ])
    );
  }

  return next();
});

// renew callback
bot.on("callback_query", async (ctx, next) => {
  const data = ctx.callbackQuery.data || "";
  const tgId = ctx.from.id;

  if (!IS_PAID) return next();

  if (data.startsWith("RENEW:")) {
    const days = Number(data.split(":")[1] || 0);
    if (![1,14,30].includes(days)) { await ctx.answerCbQuery("Paket tidak valid", { show_alert:true }); return; }

    const st = state.get(tgId);
    if (!st || st.mode !== "RENEW_DAYS") { await ctx.answerCbQuery("Session habis", { show_alert:true }); return; }

    const acc = db.prepare(`
      SELECT id, server_code, host, password, expired_at, status, is_trial
      FROM accounts
      WHERE id=? AND tg_id=?
    `).get(st.account_id, tgId);

    if (!acc || acc.status !== "active") { state.delete(tgId); await ctx.answerCbQuery("Akun tidak valid", { show_alert:true }); return; }

    const s = getServer(acc.server_code);
    if (!s) { state.delete(tgId); await ctx.answerCbQuery("Server tidak ditemukan", { show_alert:true }); return; }

    const price = Number(s.prices[String(days)] || 0);
    const saldo = getSaldo(tgId);
    if (saldo < price) { state.delete(tgId); await ctx.answerCbQuery(); return ctx.reply("Saldo tidak cukup. Silakan TopUp.", mainKb(ctx)); }
    if (!debitSaldo(tgId, price)) { state.delete(tgId); await ctx.answerCbQuery(); return ctx.reply("Saldo tidak cukup.", mainKb(ctx)); }

    const base = new Date(acc.expired_at) > new Date() ? acc.expired_at : nowIso();
    const newExp = addDaysIsoFrom(base, days);
    db.prepare(`UPDATE accounts SET expired_at=? WHERE id=?`).run(newExp, acc.id);

    state.delete(tgId);
    await ctx.answerCbQuery("Berhasil");
    return ctx.reply(`✅ Perpanjang Berhasil\n\nDomain   : ${acc.host}\nPassword : ${acc.password}\nExpired  : ${fmtWIB(newExp)}`, mainKb(ctx));
  }

  return next();
});

// ===== Auto expire: hapus password ketika expired =====
cron.schedule("*/5 * * * *", async () => {
  try {
    const expired = db.prepare(`
      SELECT id, password FROM accounts
      WHERE status='active' AND expired_at <= ?
    `).all(nowIso());

    for (const a of expired) {
      try { await zivpnDelPassword(a.password); } catch {}
      db.prepare(`UPDATE accounts SET status='expired' WHERE id=?`).run(a.id);
    }
  } catch {}
});

// ===== Webhook server (PAID only) =====
if (IS_PAID) {
  const app = express();
  app.use(express.json());

  // contoh: POST https://domainanda/pakasir/webhook?token=XXXX
  app.post(WEBHOOK_PATH, async (req, res) => {
    try {
      if (WEBHOOK_TOKEN) {
        const token = String(req.query.token || "");
        if (token !== WEBHOOK_TOKEN) return res.status(401).json({ ok:false, reason:"bad_token" });
      }

      const body = req.body || {};
      const orderId = String(body.order_id || body.orderId || "").trim();
      const amount = Number(body.amount || 0);
      const status = String(body.status || "").toLowerCase();

      if (!orderId || !amount) return res.status(400).json({ ok:false, reason:"bad_payload" });

      // hanya proses completed (jika pakasir kirim status lain -> ignore)
      if (status !== "completed") return res.json({ ok:true, ignored:true });

      // verifikasi detail biar aman
      const detail = await pakasirVerifyDetail(orderId, amount);
      const st = pickStatusFromDetail(detail);
      if (st !== "completed") return res.status(400).json({ ok:false, reason:"detail_not_completed" });

      const inv = db.prepare(`SELECT * FROM invoices WHERE order_id=?`).get(orderId);
      if (!inv) return res.json({ ok:true, ignored:true });
      if (inv.status === "paid") return res.json({ ok:true, already:true });

      db.prepare(`UPDATE invoices SET status='paid', paid_at=datetime('now') WHERE order_id=?`).run(orderId);
      addSaldo(inv.tg_id, inv.amount);

      try {
        await bot.telegram.sendMessage(inv.tg_id, `✅ TopUp berhasil\nOrder: ${orderId}\nNominal: ${rupiah(inv.amount)}`);
      } catch {}

      return res.json({ ok:true });
    } catch (e) {
      return res.status(500).json({ ok:false, error: (e.message||"").toString() });
    }
  });

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Webhook listening on 127.0.0.1:${PORT}${WEBHOOK_PATH}`);
  });
}

bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
