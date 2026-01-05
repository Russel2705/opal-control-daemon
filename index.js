const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const Database = require("better-sqlite3");
const { execFile } = require("child_process");

// ===== ENV =====
const MODE = (process.env.MODE || "paid").toLowerCase(); // paid|free
const IS_PAID = MODE === "paid";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const DB_PATH = process.env.DB_PATH || "/var/lib/opal-daemon/app.db";

const HOST = process.env.ZIVPN_HOST;
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE || 20);

// Card display
const SERVER_TITLE = process.env.SERVER_TITLE || "🟦 🇲🇨ID SERVER";
const QUOTA_GB = Number(process.env.QUOTA_GB || 150);
const IP_LIMIT = Number(process.env.IP_LIMIT || 2);
const DISPLAY_PRICE_PER_DAY = Number(process.env.DISPLAY_PRICE_PER_DAY || 0);
const DISPLAY_PRICE_PER_MONTH = Number(process.env.DISPLAY_PRICE_PER_MONTH || 0);

// FREE access control
const FREE_ACCESS_ENV = (process.env.FREE_ACCESS || "public").toLowerCase(); // public|private
const FREE_REQUIRE_CHANNEL = (process.env.FREE_REQUIRE_CHANNEL || "").trim(); // @channel (optional)

// Pricing (paid)
const PRICE_1 = Number(process.env.PRICE_1 || 0);
const PRICE_14 = Number(process.env.PRICE_14 || 0);
const PRICE_30 = Number(process.env.PRICE_30 || 0);

// Pakasir (paid)
const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/pakasir/webhook";
const PORT = Number(process.env.PORT || 9000);

if (!BOT_TOKEN) { console.error("Missing BOT_TOKEN"); process.exit(1); }
if (!HOST) { console.error("Missing ZIVPN_HOST"); process.exit(1); }
if (IS_PAID && (!PAKASIR_SLUG || !PAKASIR_API_KEY)) {
  console.error("MODE=paid but missing PAKASIR_SLUG/PAKASIR_API_KEY");
  process.exit(1);
}

// ===== INIT =====
const bot = new Telegraf(BOT_TOKEN);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ===== DB =====
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

-- FREE access control storage
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allowlist (
  tg_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_active_pass ON accounts(password, status);
CREATE INDEX IF NOT EXISTS idx_accounts_tg ON accounts(tg_id);
`);

// Seed FREE_ACCESS (db) from ENV if not exists
function settingGet(key) {
  return db.prepare(`SELECT value FROM bot_settings WHERE key=?`).get(key)?.value;
}
function settingSet(key, value) {
  db.prepare(`INSERT INTO bot_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}
if (!settingGet("FREE_ACCESS")) settingSet("FREE_ACCESS", FREE_ACCESS_ENV);

// ===== Helpers =====
function isAdmin(tgId) {
  return ADMIN_ID && Number(tgId) === Number(ADMIN_ID);
}

function rupiah(n) {
  const x = Number(n || 0);
  return "Rp" + x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "."); // Rp9.990
}

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

// ===== ZiVPN core integration =====
function zivpnAddPassword(password) {
  return new Promise((resolve, reject) => {
    execFile("sudo", ["/usr/local/bin/zivpn-passwd-manager", "add", password], (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message || "").toString()));
      resolve(stdout.trim());
    });
  });
}
function zivpnDelPassword(password) {
  return new Promise((resolve, reject) => {
    execFile("sudo", ["/usr/local/bin/zivpn-passwd-manager", "del", password], (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message || "").toString()));
      resolve(stdout.trim());
    });
  });
}

// ===== Pakasir (paid) =====
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

// ===== FREE access check =====
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

  // admin always allowed
  if (isAdmin(tgId)) return true;

  const mode = freeAccessMode(); // public/private

  // channel requirement (optional)
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

  if (mode === "public") {
    return await requireChannelOk();
  }

  // private
  if (!allowlistHas(tgId)) return false;
  return await requireChannelOk();
}

// ===== Gate middleware =====
bot.use(async (ctx, next) => {
  if (MODE === "free") {
    const ok = await isAllowedFree(ctx);
    if (!ok) {
      const id = ctx.from?.id;
      const access = freeAccessMode();
      const msg =
`⛔ Akses ditutup (MODE FREE: ${access.toUpperCase()}).

ID Anda: ${id}
Silakan kirim ID ini ke admin untuk di-allow.`;
      // reply only for interactive updates
      if (ctx.updateType === "message" || ctx.updateType === "callback_query") {
        try { await ctx.reply(msg); } catch {}
      }
      return;
    }
  }
  return next();
});

// ===== UI =====
const MAIN_KB_PAID = Markup.keyboard([
  ["➕ Buat Akun", "♻️ Perpanjang Akun"],
  ["💰 TopUp Saldo", "📌 Akun Saya"],
  ["📞 Bantuan"]
]).resize();

const MAIN_KB_FREE = Markup.keyboard([
  ["➕ Buat Akun", "♻️ Perpanjang Akun"],
  ["📌 Akun Saya", "📞 Bantuan"]
]).resize();

function MAIN_KB() { return IS_PAID ? MAIN_KB_PAID : MAIN_KB_FREE; }
function backToMenuKb() { return Markup.keyboard([["🔙 Kembali ke Menu Utama"]]).resize(); }

const state = new Map(); // tgId -> session

// ===== Admin commands (FREE access control) =====
bot.command("free", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const v = (parts[1] || "").toLowerCase();
  if (!["public", "private"].includes(v)) {
    return ctx.reply("Usage: /free public  atau  /free private");
  }
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

// ===== START =====
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

  return ctx.reply(text, MAIN_KB());
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
  return ctx.reply(text, MAIN_KB());
});

// ===== Paid-only TopUp =====
if (IS_PAID) {
  bot.hears("💰 TopUp Saldo", async (ctx) => {
    upsertUser(ctx.from.id);
    return ctx.reply(
      `💰 TOPUP SALDO\n\nMinimal TopUp: Rp 10.000\nPilih nominal atau input manual:`,
      Markup.inlineKeyboard([
        [Markup.button.callback("TopUp 10.000", "TOPUP:10000"), Markup.button.callback("TopUp 20.000", "TOPUP:20000")],
        [Markup.button.callback("TopUp 50.000", "TOPUP:50000")],
        [Markup.button.callback("✍️ Input Nominal", "TOPUP_INPUT")]
      ])
    );
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
    SELECT password, expired_at, status
    FROM accounts
    WHERE tg_id=?
    ORDER BY id DESC
    LIMIT 10
  `).all(tgId);

  if (!rows.length) return ctx.reply("📌 Anda belum punya akun.", MAIN_KB());

  let msg = "📌 AKUN ANDA (Terakhir 10)\n\n";
  for (const r of rows) {
    msg += `Domain   : ${HOST}\nPassword : ${r.password}\nExpired  : ${fmtWIB(r.expired_at)}\nStatus   : ${r.status}\n\n`;
  }
  return ctx.reply(msg.trim(), MAIN_KB());
});

bot.hears("♻️ Perpanjang Akun", async (ctx) => {
  const tgId = ctx.from.id;
  upsertUser(tgId);

  const activeList = db.prepare(`
    SELECT id, password, expired_at
    FROM accounts
    WHERE tg_id=? AND status='active'
    ORDER BY expired_at ASC
    LIMIT 20
  `).all(tgId);

  if (!activeList.length) return ctx.reply("Anda belum punya akun aktif untuk diperpanjang.", MAIN_KB());

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
      if (saldo < price) { state.delete(tgId); await ctx.answerCbQuery(); return ctx.reply("Saldo tidak cukup. Silakan TopUp.", MAIN_KB()); }
      if (!debitSaldo(tgId, price)) { state.delete(tgId); return ctx.answerCbQuery("Saldo tidak cukup.", { show_alert: true }); }
    }

    const base = new Date(acc.expired_at) > new Date() ? acc.expired_at : nowIso();
    const newExpired = addDaysIsoFrom(base, days);
    db.prepare(`UPDATE accounts SET expired_at=? WHERE id=? AND tg_id=?`).run(newExpired, acc.id, tgId);

    state.delete(tgId);
    await ctx.answerCbQuery("Berhasil.");
    return ctx.reply(`✅ Perpanjang Berhasil\n\nDomain   : ${HOST}\nPassword : ${acc.password}\nExpired  : ${fmtWIB(newExpired)}`, MAIN_KB());
  }

  return ctx.answerCbQuery("OK");
});

// ===== Text handler (password input & manual topup) =====
bot.on("text", async (ctx, next) => {
  const tgId = ctx.from.id;
  const st = state.get(tgId);
  if (!st) return next();

  const input = (ctx.message.text || "").trim();

  if (IS_PAID && st.mode === "TOPUP_AMOUNT") {
    const amount = Number(input.replace(/[^\d]/g, ""));
    if (!Number.isFinite(amount) || amount < 10000) return ctx.reply("Minimal 10.000. Contoh: 15000", backToMenuKb());

    const orderId = `TOPUP-${tgId}-${Date.now()}`;
    db.prepare(`INSERT INTO invoices(order_id,tg_id,amount,status) VALUES(?,?,?,'pending')`).run(orderId, tgId, amount);

    state.delete(tgId);
    return ctx.reply(`✅ Invoice dibuat\nOrder: ${orderId}\nNominal: ${rupiah(amount)}\n\nBayar:\n${pakasirPayLink(orderId, amount)}`, MAIN_KB());
  }

  if (st.mode === "BUY_PASSWORD") {
    const { days, price } = st;
    const password = input;

    if (!validPassword(password)) return ctx.reply("Password tidak valid (3-32, tanpa spasi/koma).", backToMenuKb());

    const dup = db.prepare(`SELECT 1 FROM accounts WHERE password=? AND status='active' LIMIT 1`).get(password);
    if (dup) return ctx.reply("Password sudah dipakai. Gunakan password lain.", backToMenuKb());

    const active = serverActiveCount();
    if (active >= MAX_ACTIVE) { state.delete(tgId); return ctx.reply("Server penuh. Coba lagi nanti.", MAIN_KB()); }

    if (IS_PAID) {
      const saldo = getSaldo(tgId);
      if (saldo < price) { state.delete(tgId); return ctx.reply("Saldo tidak cukup. Silakan TopUp.", MAIN_KB()); }
      if (!debitSaldo(tgId, price)) { state.delete(tgId); return ctx.reply("Saldo tidak cukup.", MAIN_KB()); }
    }

    try {
      await zivpnAddPassword(password);
      const expiredIso = addDaysIsoFrom(nowIso(), days);
      db.prepare(`INSERT INTO accounts(tg_id,password,expired_at,status) VALUES(?,?,?,'active')`).run(tgId, password, expiredIso);
      state.delete(tgId);

      return ctx.reply(`✅ Akun Berhasil Dibuat\n\nDomain   : ${HOST}\nPassword : ${password}\nExpired  : ${fmtWIB(expiredIso)}`, MAIN_KB());
    } catch (e) {
      if (IS_PAID) addSaldo(tgId, price);
      state.delete(tgId);

      const msg = (e.message || "").toString();
      if (msg.includes("ERR_EXISTS")) return ctx.reply("Password sudah dipakai (server). Pakai yang lain.", MAIN_KB());
      return ctx.reply(`Gagal membuat akun: ${msg}`, MAIN_KB());
    }
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