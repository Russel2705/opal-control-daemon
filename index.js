const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const express = require("express");
const QRCode = require("qrcode");
const { Telegraf, Markup, session } = require("telegraf");

// ===== ENV =====
const MODE = (process.env.MODE || "free").toLowerCase(); // free|paid
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = String(process.env.OWNER_ID || "");
const ADMIN_IDS = String(process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

const DB_DIR = process.env.DB_DIR || path.join(__dirname, "data");

const PAKASIR_PROJECT = process.env.PAKASIR_PROJECT || ""; // slug/project
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY || "";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
const PORT = Number(process.env.PORT || 9000);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/pakasir/webhook";

const TOPUP_MIN = Number(process.env.TOPUP_MIN || 10000);

const ZIVPN_PASS_MGR = process.env.ZIVPN_PASS_MGR || "/usr/local/bin/zivpn-passwd-manager";

// FREE access control (optional)
const FREE_ACCESS = (process.env.FREE_ACCESS || "public").toLowerCase(); // public|private

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

function isAdminId(userId) {
  const uid = String(userId);
  return uid === OWNER_ID || ADMIN_IDS.includes(uid);
}

function canUseBot(ctx) {
  if (MODE === "paid") return true;
  if (FREE_ACCESS === "public") return true;
  return isAdminId(ctx.from.id);
}

// ===== Load UI =====
function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error("readJsonSafe:", p, e.message);
    return fallback;
  }
}

const UI = readJsonSafe(path.join(__dirname, "config", "ui.json"), {
  brandTitle: "⚡ ZiVPN UDP PREMIUM ⚡",
  brandDesc: [],
  contact: {}
});

// ===== Simple JSON DB =====
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(DB_DIR);

const USERS_DB = path.join(DB_DIR, "users.json");
const ACC_DB = path.join(DB_DIR, "accounts.json");
const INV_DB = path.join(DB_DIR, "invoices.json");

function dbRead(file, fallback) {
  return readJsonSafe(file, fallback);
}
function dbWrite(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getUsers() { return dbRead(USERS_DB, []); }
function setUsers(x) { dbWrite(USERS_DB, x); }

function getAcc() { return dbRead(ACC_DB, []); }
function setAcc(x) { dbWrite(ACC_DB, x); }

function getInv() { return dbRead(INV_DB, []); }
function setInv(x) { dbWrite(INV_DB, x); }

// ===== Users / Balance =====
function upsertUser(userId, firstName) {
  const all = getUsers();
  const uid = String(userId);
  let u = all.find(x => String(x.userId) === uid);
  if (!u) {
    u = { userId: uid, firstName: firstName || "", balance: 0, createdAt: new Date().toISOString() };
    all.push(u);
    setUsers(all);
  } else if (firstName && u.firstName !== firstName) {
    u.firstName = firstName;
    setUsers(all);
  }
  return u;
}
function getBalance(userId) {
  const u = getUsers().find(x => String(x.userId) === String(userId));
  return u ? Number(u.balance || 0) : 0;
}
function addBalance(userId, amount) {
  const all = getUsers();
  const uid = String(userId);
  let u = all.find(x => String(x.userId) === uid);
  if (!u) {
    u = { userId: uid, firstName: "", balance: 0, createdAt: new Date().toISOString() };
    all.push(u);
  }
  u.balance = Number(u.balance || 0) + Number(amount || 0);
  setUsers(all);
  return u.balance;
}
function subBalance(userId, amount) {
  const all = getUsers();
  const uid = String(userId);
  let u = all.find(x => String(x.userId) === uid);
  if (!u) return false;
  const cur = Number(u.balance || 0);
  if (cur < amount) return false;
  u.balance = cur - amount;
  setUsers(all);
  return true;
}

// ===== Servers =====
function loadServers() {
  const p = path.join(__dirname, "config", "servers.json");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(s => s && s.enabled !== false);
  } catch (e) {
    console.error("servers.json invalid:", e.message);
    return [];
  }
}
function getServer(code) {
  return loadServers().find(s => s.code === code);
}

function nowISO() { return new Date().toISOString(); }
function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString();
}

function isExpired(acc) {
  return new Date(acc.expiredAt).getTime() <= Date.now();
}

function activeAccounts() {
  // active + not expired (logic)
  const all = getAcc();
  return all.filter(a => a && a.status === "active" && !isExpired(a));
}

function countUsed(serverCode) {
  return activeAccounts().filter(a => a.serverCode === serverCode).length;
}

function formatRupiah(n) {
  const x = Number(n || 0);
  return "Rp" + x.toLocaleString("id-ID");
}

function serverCard(s) {
  const used = countUsed(s.code);
  const cap = Number(s.capacity || 0);
  const status = (cap > 0 && used >= cap) ? "⚠️ Penuh" : "✅ Tersedia";
  const p1 = s.prices?.["1"] ?? 0;
  const p30 = s.prices?.["30"] ?? 0;

  return [
    "╔══════════════════════╗",
    `  ${s.name || s.code}`,
    "╚══════════════════════╝",
    `🛜 Domain: ${s.host}`,
    `💳 Harga/1 hari: ${formatRupiah(p1)}`,
    `📆 Harga/30 hari: ${formatRupiah(p30)}`,
    `📡 Quota: ${Number(s.quota_gb || 0)} GB`,
    `🔐 IP Limit: ${Number(s.ip_limit || 1)} IP`,
    `👥 Akun Terpakai: ${used}/${cap || "-"}`,
    `📌 Status: ${status}`
  ].join("\n");
}

// ===== Stats =====
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d = new Date()) {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}
function startOfMonth(d = new Date()) { const x = startOfDay(d); x.setDate(1); return x; }

function countCreated({ userId = null, from = null } = {}) {
  const all = getAcc();
  return all.filter(a => {
    if (!a) return false;
    const t = new Date(a.createdAt || 0).getTime();
    if (from && t < from.getTime()) return false;
    if (userId && String(a.userId) !== String(userId)) return false;
    return true;
  }).length;
}

// ===== ZIVPN Password ops =====
function passCheck(pass) {
  return new Promise((resolve) => {
    execFile(ZIVPN_PASS_MGR, ["check", pass], (err, stdout) => {
      const out = String(stdout || "").trim();
      if (!err && out === "EXISTS") return resolve(true);
      return resolve(false);
    });
  });
}
function passAdd(pass) {
  return new Promise((resolve, reject) => {
    execFile(ZIVPN_PASS_MGR, ["add", pass], (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message)));
      resolve(String(stdout || "").trim());
    });
  });
}
function passDel(pass) {
  return new Promise((resolve) => {
    execFile(ZIVPN_PASS_MGR, ["del", pass], () => resolve(true));
  });
}

// ===== Bot =====
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

bot.catch((err) => console.error("BOT ERROR:", err));
process.on("unhandledRejection", (r) => console.error("UNHANDLED:", r));
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));

function mainKb(ctx) {
  const rows = [
    ["➕ Buat Akun", "♻️ Perpanjang Akun"],
    ["⏳ Trial Akun", MODE === "paid" ? "💰 TopUp Saldo" : "📌 Bantuan"],
    ["📌 Akun Saya", "📞 Bantuan"]
  ];
  if (isAdminId(ctx.from.id)) rows.push(["⚙️ Admin Panel"]);
  return Markup.keyboard(rows).resize();
}

function adminKb() {
  return Markup.keyboard([
    ["📋 List Akun Aktif", "🔎 Cari Akun"],
    ["🗑️ Delete Akun", "💳 Tambah Saldo User"],
    ["⬅️ Kembali"]
  ]).resize();
}

function denyIfPrivate(ctx) {
  if (!canUseBot(ctx)) {
    return ctx.reply("❌ Bot ini mode PRIVATE. Hubungi admin untuk akses.");
  }
  return null;
}

bot.start(async (ctx) => {
  const denied = denyIfPrivate(ctx); if (denied) return;
  upsertUser(ctx.from.id, ctx.from.first_name);

  const uid = ctx.from.id;
  const saldo = getBalance(uid);

  const today = countCreated({ userId: uid, from: startOfDay() });
  const week  = countCreated({ userId: uid, from: startOfWeek() });
  const month = countCreated({ userId: uid, from: startOfMonth() });

  const gToday = countCreated({ from: startOfDay() });
  const gWeek  = countCreated({ from: startOfWeek() });
  const gMonth = countCreated({ from: startOfMonth() });

  const c = UI.contact || {};
  const lines = [
    `╭━ ${UI.brandTitle} ━╮`,
    ...(UI.brandDesc || []).map(x => `┃ ${x}`),
    "╰━━━━━━━━━━━━━━━━━━╯",
    "",
    `👋 Hai, ${ctx.from.first_name}!`,
    `ID: ${uid}`,
    `Saldo: ${formatRupiah(saldo)}`,
    `Mode: ${MODE.toUpperCase()}`,
    "",
    "📊 Statistik Anda",
    `• Hari ini : ${today} akun`,
    `• Minggu ini: ${week} akun`,
    `• Bulan ini : ${month} akun`,
    "",
    "🌍 Statistik Global",
    `• Hari ini : ${gToday} akun`,
    `• Minggu ini: ${gWeek} akun`,
    `• Bulan ini : ${gMonth} akun`,
    "",
    "☎️ Bantuan / Kontak",
    c.telegram ? `• Telegram: ${c.telegram}` : null,
    c.whatsapp ? `• WhatsApp: ${c.whatsapp}` : null,
    c.text ? `• ${c.text}` : null
  ].filter(Boolean);

  return ctx.reply(lines.join("\n"), mainKb(ctx));
});

bot.hears("📞 Bantuan", async (ctx) => {
  const denied = denyIfPrivate(ctx); if (denied) return;
  const c = UI.contact || {};
  const msg = [
    "📞 Bantuan / Kontak",
    c.telegram ? `• Telegram: ${c.telegram}` : null,
    c.whatsapp ? `• WhatsApp: ${c.whatsapp}` : null,
    c.text ? `• ${c.text}` : null
  ].filter(Boolean).join("\n");
  return ctx.reply(msg, mainKb(ctx));
});

// ===== Server list inline buttons =====
function serversInline() {
  const sv = loadServers();
  const buttons = sv.map(s => Markup.button.callback(s.code, `srv:${s.code}`));
  // 2 kolom
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return Markup.inlineKeyboard(rows);
}

function packageInline(serverCode, isTrial=false) {
  const s = getServer(serverCode);
  const days = [1, 14, 30];
  const rows = days.map(d => {
    let price = 0;
    if (!isTrial && MODE === "paid") price = Number(s?.prices?.[String(d)] || 0);
    return [Markup.button.callback(`${d} Hari ${MODE==="paid" && !isTrial ? `(${formatRupiah(price)})` : "(GRATIS)"}`, `pkg:${serverCode}:${d}:${isTrial?1:0}`)];
  });
  rows.push([Markup.button.callback("⬅️ Kembali", "back:servers")]);
  return Markup.inlineKeyboard(rows);
}

bot.hears("➕ Buat Akun", async (ctx) => {
  const denied = denyIfPrivate(ctx); if (denied) return;

  const sv = loadServers();
  if (!sv.length) return ctx.reply("❌ Config server belum ada. Isi: config/servers.json", mainKb(ctx));

  const text = sv.map(serverCard).join("\n\n");
  return ctx.reply(text, serversInline());
});

bot.hears("⏳ Trial Akun", async (ctx) => {
  const denied = denyIfPrivate(ctx); if (denied) return;

  const sv = loadServers();
  if (!sv.length) return ctx.reply("❌ Config server belum ada. Isi: config/servers.json", mainKb(ctx));

  // Trial: hanya 1x per user (contoh sederhana)
  const u = upsertUser(ctx.from.id, ctx.from.first_name);
  const users = getUsers();
  const me = users.find(x => x.userId === u.userId);
  if (me && me.trialUsed) {
    return ctx.reply("❌ Trial hanya 1x untuk tiap user.", mainKb(ctx));
  }

  const text = "✅ PILIH SERVER (TRIAL)\n\n" + sv.map(serverCard).join("\n\n");
  return ctx.reply(text, serversInline());
});

bot.action("back:servers", async (ctx) => {
  await ctx.answerCbQuery();
  const sv = loadServers();
  const text = sv.map(serverCard).join("\n\n");
  return ctx.editMessageText(text, serversInline());
});

bot.action(/^srv:(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  const s = getServer(code);
  if (!s) return ctx.reply("Server tidak ditemukan.");

  const isTrial = (ctx.update.callback_query.message.text || "").includes("(TRIAL)") || false;
  const msg = serverCard(s) + "\n\n🛒 Pilih Paket:";
  return ctx.editMessageText(msg, packageInline(code, isTrial));
});

bot.action(/^pkg:([^:]+):(\d+):(\d)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const serverCode = ctx.match[1];
  const days = Number(ctx.match[2]);
  const isTrial = ctx.match[3] === "1";

  const s = getServer(serverCode);
  if (!s) return ctx.reply("Server tidak ditemukan.");

  // cek slot
  const used = countUsed(serverCode);
  if (s.capacity && used >= s.capacity) return ctx.reply("⚠️ Server penuh. Pilih server lain.", mainKb(ctx));

  // paid: cek saldo
  let price = 0;
  if (MODE === "paid" && !isTrial) {
    price = Number(s.prices?.[String(days)] || 0);
    if (price <= 0) return ctx.reply("Harga paket belum diset di servers.json");
    const bal = getBalance(ctx.from.id);
    if (bal < price) return ctx.reply(`❌ Saldo kurang. Harga: ${formatRupiah(price)}\nSaldo: ${formatRupiah(bal)}`, mainKb(ctx));
  }

  ctx.session.flow = {
    type: isTrial ? "trial" : "create",
    serverCode,
    days,
    price
  };

  return ctx.reply(
    `🔑 Masukkan password akun\nAturan:\n• 3-32 karakter\n• Tanpa spasi/koma\n• Harus unik\n\nPaket: ${days} hari`,
    mainKb(ctx)
  );
});

// ===== Perpanjang =====
bot.hears("♻️ Perpanjang Akun", async (ctx) => {
  const denied = denyIfPrivate(ctx); if (denied) return;
  ctx.session.renew = true;
  return ctx.reply("🔑 Kirim password akun yang ingin diperpanjang:", mainKb(ctx));
});

// ===== Akun Saya =====
bot.hears("📌 Akun Saya", async (ctx) => {
  const denied = denyIfPrivate(ctx); if (denied) return;
  const uid = String(ctx.from.id);
  const mine = activeAccounts().filter(a => String(a.userId) === uid);
  if (!mine.length) return ctx.reply("Belum ada akun aktif.", mainKb(ctx));

  const msg = mine.map((a, i) =>
    `${i+1}) Domain: ${a.host}\nPassword: ${a.password}\nExpired: ${new Date(a.expiredAt).toLocaleString("id-ID")}\nServer: ${a.serverCode}\n---`
  ).join("\n");

  return ctx.reply(msg, mainKb(ctx));
});

// ===== TopUp (PAID) =====
bot.hears("💰 TopUp Saldo", async (ctx) => {
  const denied = denyIfPrivate(ctx); if (denied) return;
  if (MODE !== "paid") return ctx.reply("Fitur topup hanya untuk mode PAID.", mainKb(ctx));

  ctx.session.topup = true;
  return ctx.reply(`Masukkan nominal topup (min ${formatRupiah(TOPUP_MIN)}). Contoh: 10000`, mainKb(ctx));
});

// ===== Admin Panel =====
bot.hears("⚙️ Admin Panel", async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.reply("❌ Akses ditolak.");
  return ctx.reply("⚙️ Admin Panel", adminKb());
});

bot.hears("⬅️ Kembali", async (ctx) => {
  return ctx.reply("Kembali ke menu utama.", mainKb(ctx));
});

bot.hears("📋 List Akun Aktif", async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.reply("❌ Akses ditolak.");
  const acc = activeAccounts().slice(-50).reverse();
  if (!acc.length) return ctx.reply("Belum ada akun aktif.", adminKb());

  const msg = acc.map((a, i) =>
    `${i+1}) ${a.serverCode}\nDomain: ${a.host}\nPass: ${a.password}\nExp: ${new Date(a.expiredAt).toLocaleString("id-ID")}\nUserID: ${a.userId}\n---`
  ).join("\n");
  return ctx.reply(msg, adminKb());
});

bot.hears("🔎 Cari Akun", async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.reply("❌ Akses ditolak.");
  ctx.session.findPass = true;
  return ctx.reply("Kirim password akun untuk dicek:", adminKb());
});

bot.hears("🗑️ Delete Akun", async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.reply("❌ Akses ditolak.");
  ctx.session.delPass = true;
  return ctx.reply("Kirim password akun untuk dihapus:", adminKb());
});

bot.hears("💳 Tambah Saldo User", async (ctx) => {
  if (!isAdminId(ctx.from.id)) return ctx.reply("❌ Akses ditolak.");
  ctx.session.addSaldo = true;
  return ctx.reply("Format: <user_id> <nominal>\nContoh: 5688411076 20000", adminKb());
});

// ===== Text handler for flows =====
bot.on("text", async (ctx) => {
  const denied = denyIfPrivate(ctx); if (denied) return;

  const text = String(ctx.message.text || "").trim();
  upsertUser(ctx.from.id, ctx.from.first_name);

  // Admin: find
  if (ctx.session.findPass && isAdminId(ctx.from.id)) {
    ctx.session.findPass = false;
    const a = getAcc().find(x => x.password === text);
    if (!a) return ctx.reply("Tidak ditemukan.", adminKb());
    return ctx.reply(
      `✅ Ditemukan\nDomain: ${a.host}\nPass: ${a.password}\nExp: ${new Date(a.expiredAt).toLocaleString("id-ID")}\nStatus: ${a.status}\nUserID: ${a.userId}`,
      adminKb()
    );
  }

  // Admin: delete
  if (ctx.session.delPass && isAdminId(ctx.from.id)) {
    ctx.session.delPass = false;
    const pass = text;
    const all = getAcc();
    const idx = all.findIndex(a => a.password === pass && a.status === "active");
    if (idx === -1) return ctx.reply("Akun tidak ditemukan / sudah dihapus.", adminKb());

    all[idx].status = "deleted";
    all[idx].deletedAt = nowISO();
    all[idx].deletedReason = "admin";
    setAcc(all);

    await passDel(pass);
    return ctx.reply("✅ Akun sudah dihapus.", adminKb());
  }

  // Admin: add saldo
  if (ctx.session.addSaldo && isAdminId(ctx.from.id)) {
    ctx.session.addSaldo = false;
    const parts = text.split(/\s+/);
    if (parts.length < 2) return ctx.reply("Format salah. Contoh: 5688411076 20000", adminKb());
    const uid = parts[0];
    const amt = Number(parts[1]);
    if (!amt || amt <= 0) return ctx.reply("Nominal tidak valid.", adminKb());
    addBalance(uid, amt);
    return ctx.reply(`✅ Saldo user ${uid} ditambah ${formatRupiah(amt)}`, adminKb());
  }

  // Renew flow
  if (ctx.session.renew) {
    ctx.session.renew = false;
    const pass = text;

    const all = getAcc();
    const a = all.find(x => x.password === pass && x.status === "active" && !isExpired(x));
    if (!a) return ctx.reply("❌ Akun tidak ditemukan / sudah expired.", mainKb(ctx));

    // tampil pilihan paket (sesuai server)
    const s = getServer(a.serverCode);
    if (!s) return ctx.reply("Server config tidak ditemukan.", mainKb(ctx));

    ctx.session.flow = { type: "renew", password: pass, serverCode: a.serverCode };
    const rows = [1,14,30].map(d => {
      const price = (MODE === "paid") ? Number(s.prices?.[String(d)] || 0) : 0;
      return [Markup.button.callback(`${d} Hari ${MODE==="paid" ? `(${formatRupiah(price)})` : "(GRATIS)"}`, `renew:${pass}:${d}`)];
    });
    return ctx.reply("Pilih paket perpanjang:", Markup.inlineKeyboard(rows));
  }

  // Create/trial flow awaiting password
  if (ctx.session.flow && (ctx.session.flow.type === "create" || ctx.session.flow.type === "trial")) {
    const { serverCode, days, price, type } = ctx.session.flow;
    ctx.session.flow = null;

    const pass = text;

    // simple validation
    if (pass.length < 3 || pass.length > 32 || pass.includes(" ") || pass.includes(",")) {
      return ctx.reply("❌ Password tidak valid. (3-32 char, tanpa spasi/koma)", mainKb(ctx));
    }

    // cek unik (DB + config)
    const existsDb = activeAccounts().some(a => a.password === pass);
    const existsSys = await passCheck(pass);
    if (existsDb || existsSys) return ctx.reply("❌ Password sudah dipakai. Gunakan yang lain.", mainKb(ctx));

    const s = getServer(serverCode);
    if (!s) return ctx.reply("Server tidak ditemukan.", mainKb(ctx));

    // paid: potong saldo
    if (MODE === "paid" && type !== "trial") {
      const ok = subBalance(ctx.from.id, Number(price));
      if (!ok) return ctx.reply("❌ Saldo kurang.", mainKb(ctx));
    }

    // add password to zivpn
    try {
      await passAdd(pass);
    } catch (e) {
      // refund kalau paid
      if (MODE === "paid" && type !== "trial") addBalance(ctx.from.id, Number(price));
      return ctx.reply(`❌ Gagal membuat akun: ${e.message}`, mainKb(ctx));
    }

    // store account
    const all = getAcc();
    const exp = addDaysISO(days);

    all.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      userId: String(ctx.from.id),
      serverCode,
      host: s.host,
      password: pass,
      createdAt: nowISO(),
      expiredAt: exp,
      status: "active"
    });
    setAcc(all);

    // trial mark
    if (type === "trial") {
      const users = getUsers();
      const u = users.find(x => x.userId === String(ctx.from.id));
      if (u) { u.trialUsed = true; setUsers(users); }
    }

    return ctx.reply(
      `✅ Akun Berhasil Dibuat\n\nDomain : ${s.host}\nPassword : ${pass}\nExpired : ${new Date(exp).toLocaleString("id-ID")}`,
      mainKb(ctx)
    );
  }

  // Topup flow
  if (ctx.session.topup && MODE === "paid") {
    ctx.session.topup = false;
    const amount = Number(text.replace(/[^\d]/g, ""));
    if (!amount || amount < TOPUP_MIN) return ctx.reply(`❌ Minimal topup ${formatRupiah(TOPUP_MIN)}`, mainKb(ctx));

    if (!PAKASIR_PROJECT || !PAKASIR_API_KEY) {
      return ctx.reply("❌ Pakasir belum diset. Isi PAKASIR_PROJECT & PAKASIR_API_KEY di env.", mainKb(ctx));
    }

    const orderId = `TOPUP-${ctx.from.id}-${Date.now()}`;

    // Pakasir Transaction Create QRIS (official)
    // POST https://app.pakasir.com/api/transactioncreate/qris body: project, order_id, amount, api_key :contentReference[oaicite:1]{index=1}
    let res;
    try {
      res = await fetch("https://app.pakasir.com/api/transactioncreate/qris", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: PAKASIR_PROJECT,
          order_id: orderId,
          amount: amount,
          api_key: PAKASIR_API_KEY
        })
      });
    } catch (e) {
      return ctx.reply("❌ Gagal konek ke Pakasir (network). Coba lagi.", mainKb(ctx));
    }

    if (!res.ok) {
      const t = await res.text().catch(()=> "");
      return ctx.reply(`❌ Pakasir error: HTTP ${res.status}\n${t.slice(0,300)}`, mainKb(ctx));
    }

    const data = await res.json().catch(()=> null);
    const pay = data?.payment;
    if (!pay?.payment_number) return ctx.reply("❌ Respon Pakasir tidak valid.", mainKb(ctx));

    const qrString = pay.payment_number;
    const expAt = pay.expired_at || null;
    const totalPay = pay.total_payment || amount;

    // generate QR image
    const png = await QRCode.toBuffer(qrString, { type: "png", width: 420 });

    // store invoice
    const inv = getInv();
    inv.push({
      orderId,
      userId: String(ctx.from.id),
      project: PAKASIR_PROJECT,
      amount,
      totalPay,
      status: "pending",
      createdAt: nowISO()
    });
    setInv(inv);

    return ctx.replyWithPhoto(
      { source: png },
      {
        caption:
          `✅ TopUp Dibuat\nOrder: ${orderId}\nNominal: ${formatRupiah(amount)}\nTotal Bayar: ${formatRupiah(totalPay)}\n` +
          (expAt ? `Expired: ${expAt}\n` : "") +
          `\nSilakan scan QRIS.\n\nJika sudah bayar, saldo masuk otomatis.`
      }
    );
  }
});

// Renew callback
bot.action(/^renew:([^:]+):(\d+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const pass = ctx.match[1];
  const days = Number(ctx.match[2]);

  const all = getAcc();
  const a = all.find(x => x.password === pass && x.status === "active" && !isExpired(x));
  if (!a) return ctx.reply("❌ Akun tidak ditemukan / sudah expired.", mainKb(ctx));

  const s = getServer(a.serverCode);
  if (!s) return ctx.reply("Server config tidak ditemukan.", mainKb(ctx));

  const price = (MODE === "paid") ? Number(s.prices?.[String(days)] || 0) : 0;
  if (MODE === "paid") {
    const ok = subBalance(ctx.from.id, price);
    if (!ok) return ctx.reply("❌ Saldo kurang untuk perpanjang.", mainKb(ctx));
  }

  const cur = new Date(a.expiredAt);
  cur.setDate(cur.getDate() + days);
  a.expiredAt = cur.toISOString();
  setAcc(all);

  return ctx.reply(
    `✅ Perpanjang Berhasil\n\nDomain : ${a.host}\nPassword : ${a.password}\nExpired : ${new Date(a.expiredAt).toLocaleString("id-ID")}`,
    mainKb(ctx)
  );
});

// ===== Auto-expire job (hapus password kalau expired) =====
setInterval(async () => {
  const all = getAcc();
  let changed = false;

  for (const a of all) {
    if (!a || a.status !== "active") continue;
    if (!isExpired(a)) continue;

    a.status = "deleted";
    a.deletedAt = nowISO();
    a.deletedReason = "expired";
    changed = true;

    await passDel(a.password);
  }

  if (changed) setAcc(all);
}, 60 * 1000);

// ===== Webhook server (Pakasir) =====
const app = express();
app.use(express.json({ limit: "1mb" }));

app.post(WEBHOOK_PATH, async (req, res) => {
  // token guard
  if (WEBHOOK_TOKEN) {
    const t = String(req.query.token || "");
    if (t !== WEBHOOK_TOKEN) return res.status(401).json({ ok: false, error: "bad_token" });
  }

  const body = req.body || {};

  // Pakasir webhook payload: amount, order_id, project, status, payment_method, completed_at :contentReference[oaicite:2]{index=2}
  const orderId = String(body.order_id || "");
  const amount = Number(body.amount || 0);
  const project = String(body.project || "");
  const status = String(body.status || "");

  if (!orderId || !amount || !project) return res.status(400).json({ ok: false, error: "bad_payload" });

  // verify with transactiondetail (recommended by Pakasir) :contentReference[oaicite:3]{index=3}
  if (!PAKASIR_API_KEY) return res.status(500).json({ ok: false, error: "api_key_missing" });

  try {
    const url =
      `https://app.pakasir.com/api/transactiondetail?project=${encodeURIComponent(project)}` +
      `&amount=${encodeURIComponent(amount)}` +
      `&order_id=${encodeURIComponent(orderId)}` +
      `&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;

    const r = await fetch(url);
    const j = await r.json().catch(()=> null);
    const tStatus = j?.transaction?.status;

    if (tStatus !== "completed") return res.json({ ok: true, ignored: true, status: tStatus });

    // mark invoice + credit balance
    const inv = getInv();
    const i = inv.find(x => x.orderId === orderId && x.status === "pending");
    if (!i) return res.json({ ok: true, note: "invoice_not_found_or_already_done" });

    i.status = "paid";
    i.paidAt = nowISO();

    setInv(inv);

    // credit "amount" to balance
    addBalance(i.userId, i.amount);

    return res.json({ ok: true });
  } catch (e) {
    console.error("webhook error:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Webhook listening on 127.0.0.1:${PORT}${WEBHOOK_PATH}`);
});

// ===== Launch bot =====
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log("Bot started");
});
