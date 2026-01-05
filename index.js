/**
 * Opal ZiVPN Bot - FINAL index.js
 * - Telegraf bot + Express webhook (Pakasir)
 * - FREE/PAID mode
 * - Topup QRIS via Pakasir (generate QR image)
 * - Create/Trial/Renew ZiVPN accounts (password-based)
 * - Admin panel (delete requires userId + password)
 *
 * Requirements (package.json deps):
 *   telegraf, express, body-parser, node-fetch, qrcode
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { Telegraf, Markup, session } = require("telegraf");
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const QRCode = require("qrcode");

// =================== ENV ===================
const MODE = (process.env.MODE || "paid").toLowerCase(); // "free" / "paid"
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OWNER_ID = String(process.env.OWNER_ID || "");
const ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const DB_DIR = process.env.DB_DIR || "/var/lib/opal-daemon";

const PAKASIR_PROJECT = process.env.PAKASIR_PROJECT || "";
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY || "";
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/pakasir/webhook";
const PORT = Number(process.env.PORT || 9000);
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || ""; // validate query token
const TOPUP_MIN = Number(process.env.TOPUP_MIN || 10000);

const FREE_ACCESS = (process.env.FREE_ACCESS || "public").toLowerCase(); // public/private
const TRIAL_HOURS = Number(process.env.TRIAL_HOURS || 3);

const ZIVPN_PASS_MGR = process.env.ZIVPN_PASS_MGR || "/usr/local/bin/zivpn-passwd-manager";

const CONTACT_TELEGRAM = process.env.CONTACT_TELEGRAM || "@admin";
const CONTACT_WHATSAPP = process.env.CONTACT_WHATSAPP || "628xxxxxxxxxx";

// =================== Safety checks ===================
if (!BOT_TOKEN) {
  console.error("FATAL: BOT_TOKEN kosong.");
  process.exit(1);
}
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// =================== Files ===================
const USERS_FILE = path.join(DB_DIR, "users.json");
const ACC_FILE = path.join(DB_DIR, "accounts.json");
const PAY_FILE = path.join(DB_DIR, "payments.json");
const STATS_FILE = path.join(DB_DIR, "stats.json");

const CONFIG_DIR = path.join(__dirname, "config");
const SERVERS_FILE = path.join(CONFIG_DIR, "servers.json");
const UI_FILE = path.join(CONFIG_DIR, "ui.json");

// =================== UI Defaults ===================
const UI_DEFAULT = {
  brandTitle: "ZIVPN UDP PREMIUM",
  brandDesc: ["Bot VPN UDP Premium dengan sistem otomatis", "Akses internet cepat & aman"],
  contact: {
    telegram: CONTACT_TELEGRAM,
    whatsapp: CONTACT_WHATSAPP,
    text: "Jika ada kendala akun/pembayaran, hubungi admin.",
  },
};

// =================== Server Defaults ===================
// Isi sesuai domain bapak: id.xstrore1.cloud
const SERVERS_DEFAULT = [
  {
    code: "ID1",
    name: "🇲🇨 ID 1",
    enabled: true,
    domain: "id.xstrore1.cloud",
    quotaGB: 150,
    maxAccounts: 9999, // slot (bisa bapak kecilkan)
    ipLimits: [1, 2],
    prices: {
      d1: 1000,
      d14: 9000,
      d30: 15000,
    },
  },
];

// =================== Helpers ===================
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nowISO() {
  return new Date().toISOString();
}

function addHoursISO(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}
function addDaysISO(days) {
  return new Date(Date.now() + days * 86400 * 1000).toISOString();
}
function isExpired(expiredAt) {
  return Date.parse(expiredAt) <= Date.now();
}

function formatRupiah(n) {
  const num = Number(n || 0);
  return "Rp" + num.toLocaleString("id-ID");
}

function safeReadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error("READ JSON ERROR:", file, e);
    return fallback;
  }
}

function atomicWriteJSON(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function randId(prefix = "ID") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function isOwnerOrAdmin(uid) {
  const s = String(uid);
  if (OWNER_ID && s === OWNER_ID) return true;
  return ADMIN_IDS.includes(s);
}

function denyIfPrivate(ctx) {
  if (MODE === "free" && FREE_ACCESS === "private") {
    // only owner/admin allowed
    if (!isOwnerOrAdmin(ctx.from.id)) {
      ctx.reply("❌ Bot sedang mode PRIVATE.");
      return true;
    }
  }
  return false;
}

function getUsers() {
  return safeReadJSON(USERS_FILE, []);
}
function setUsers(users) {
  atomicWriteJSON(USERS_FILE, users);
}
function upsertUser(userId, name) {
  const users = getUsers();
  const idx = users.findIndex((u) => String(u.userId) === String(userId));
  if (idx === -1) {
    users.push({
      userId: String(userId),
      name: name || "",
      balance: 0,
      trialUsed: false,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
  } else {
    users[idx].name = name || users[idx].name;
    users[idx].updatedAt = nowISO();
  }
  setUsers(users);
}
function getUser(userId) {
  const users = getUsers();
  return users.find((u) => String(u.userId) === String(userId)) || null;
}
function getBalance(userId) {
  const u = getUser(userId);
  return u ? Number(u.balance || 0) : 0;
}
function setBalance(userId, newBal) {
  const users = getUsers();
  const idx = users.findIndex((u) => String(u.userId) === String(userId));
  if (idx === -1) return;
  users[idx].balance = Number(newBal || 0);
  users[idx].updatedAt = nowISO();
  setUsers(users);
}
function addBalance(userId, amount) {
  const bal = getBalance(userId);
  setBalance(userId, bal + Number(amount || 0));
}

function getAcc() {
  return safeReadJSON(ACC_FILE, []);
}
function setAcc(arr) {
  atomicWriteJSON(ACC_FILE, arr);
}

function getPayments() {
  return safeReadJSON(PAY_FILE, []);
}
function setPayments(arr) {
  atomicWriteJSON(PAY_FILE, arr);
}

function getStats() {
  return safeReadJSON(STATS_FILE, { created: [] });
}
function pushCreateStat(userId) {
  const s = getStats();
  s.created.push({ userId: String(userId), at: nowISO() });
  // keep last 10k
  if (s.created.length > 10000) s.created = s.created.slice(-10000);
  atomicWriteJSON(STATS_FILE, s);
}
function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function startOfWeek() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0 ? 6 : day - 1); // make Monday start
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function countCreated({ userId, from }) {
  const s = getStats();
  return s.created.filter((x) => {
    const okFrom = Date.parse(x.at) >= Date.parse(from);
    const okUser = userId ? String(x.userId) === String(userId) : true;
    return okFrom && okUser;
  }).length;
}

// =================== Config files ensure ===================
function ensureConfigFiles() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (!fs.existsSync(SERVERS_FILE)) {
    atomicWriteJSON(SERVERS_FILE, SERVERS_DEFAULT);
  }
  if (!fs.existsSync(UI_FILE)) {
    atomicWriteJSON(UI_FILE, UI_DEFAULT);
  }
}

function loadUI() {
  ensureConfigFiles();
  const ui = safeReadJSON(UI_FILE, UI_DEFAULT);
  // merge basic
  return {
    ...UI_DEFAULT,
    ...ui,
    contact: { ...UI_DEFAULT.contact, ...(ui.contact || {}) },
  };
}

function loadServers() {
  ensureConfigFiles();
  const raw = safeReadJSON(SERVERS_FILE, SERVERS_DEFAULT);
  return Array.isArray(raw) ? raw.filter((s) => s && s.enabled) : SERVERS_DEFAULT.filter((s) => s.enabled);
}

function getServer(code) {
  return loadServers().find((s) => String(s.code) === String(code)) || null;
}

// =================== ZiVPN password manager ===================
function execCmd(file, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        return reject({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function passAdd(pass) {
  await execCmd(ZIVPN_PASS_MGR, ["add", pass], 15000);
}
async function passDel(pass) {
  await execCmd(ZIVPN_PASS_MGR, ["del", pass], 15000);
}
async function passCheck(pass) {
  try {
    const r = await execCmd(ZIVPN_PASS_MGR, ["check", pass], 15000);
    // script biasanya exit 0 untuk found / notfound; kita cek teks
    const out = (r.stdout + r.stderr).toLowerCase();
    if (out.includes("found") || out.includes("exists") || out.includes("true")) return true;
    if (out.includes("not") && out.includes("found")) return false;
    // fallback: if no clear text, assume not exist
    return false;
  } catch (e) {
    // if command fails, assume exists to be safe
    return true;
  }
}

function passwordUsedInAccounts(pass) {
  const acc = getAcc();
  return acc.some((a) => a.status === "active" && a.password === pass);
}

// =================== Pakasir ===================
async function pakasirCreateQRIS({ orderId, amount }) {
  // API per docs: POST https://app.pakasir.com/api/transactioncreate/qris
  // body: { project, order_id, amount, api_key } :contentReference[oaicite:1]{index=1}
  const url = "https://app.pakasir.com/api/transactioncreate/qris";
  const body = {
    project: PAKASIR_PROJECT,
    order_id: orderId,
    amount: Number(amount),
    api_key: PAKASIR_API_KEY,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PAKASIR create failed: ${res.status} ${t}`);
  }
  const js = await res.json();
  if (!js || !js.payment || !js.payment.payment_number) {
    throw new Error("PAKASIR create response invalid");
  }
  return js.payment; // includes payment_number + expired_at + total_payment
}

async function pakasirDetail({ orderId, amount }) {
  // GET transactiondetail per docs :contentReference[oaicite:2]{index=2}
  const qs = new URLSearchParams({
    project: PAKASIR_PROJECT,
    amount: String(amount),
    order_id: String(orderId),
    api_key: PAKASIR_API_KEY,
  }).toString();

  const url = `https://app.pakasir.com/api/transactiondetail?${qs}`;
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PAKASIR detail failed: ${res.status} ${t}`);
  }
  const js = await res.json();
  return js.transaction || null;
}

async function qrToPngBuffer(qrString) {
  // Create PNG buffer
  return QRCode.toBuffer(qrString, { type: "png", width: 512, margin: 2 });
}

// =================== Bot menus ===================
function mainKb(ctx) {
  const rows = [];

  rows.push(["➕ Buat Akun", "⏳ Trial Akun"]);
  rows.push(["♻️ Perpanjang Akun", "📌 Akun Saya"]);
  if (MODE === "paid") rows.push(["💰 TopUp Saldo"]);
  rows.push(["📞 Bantuan"]);

  if (isOwnerOrAdmin(ctx.from.id)) rows.push(["⚙️ Admin Panel"]);

  return Markup.keyboard(rows).resize();
}

function adminKb() {
  return Markup.keyboard([
    ["📋 List Akun Aktif", "🔎 Cari Akun"],
    ["🗑️ Delete Akun", "💳 Tambah Saldo User"],
    ["💰 Cek Saldo User"],
    ["⬅️ Kembali"],
  ]).resize();
}

function planLabel(plan) {
  if (plan === "d1") return "1 Hari";
  if (plan === "d14") return "14 Hari";
  if (plan === "d30") return "30 Hari";
  if (plan === "trial") return `Trial ${TRIAL_HOURS} Jam`;
  return plan;
}

function planExpireAt(plan) {
  if (plan === "d1") return addDaysISO(1);
  if (plan === "d14") return addDaysISO(14);
  if (plan === "d30") return addDaysISO(30);
  if (plan === "trial") return addHoursISO(TRIAL_HOURS);
  return addDaysISO(1);
}

function serverInfoText(server) {
  const acc = getAcc();
  const used = acc.filter((a) => a.status === "active" && a.serverCode === server.code).length;
  const max = server.maxAccounts || 0;

  const quota = server.quotaGB ? `${server.quotaGB} GB` : "-";
  const ipLimitText = Array.isArray(server.ipLimits) ? server.ipLimits.join(" / ") : "-";

  const dayPrice = server.prices?.d1 ?? 0;
  const monthPrice = server.prices?.d30 ?? 0;

  return (
    `╔══════════════════════╗\n` +
    `  🟦 ${server.name}\n` +
    `╚══════════════════════╝\n` +
    `🛜 Domain: ${server.domain}\n` +
    `💳 Harga/Hari: ${formatRupiah(dayPrice)}\n` +
    `📆 Harga/30 Hari: ${formatRupiah(monthPrice)}\n` +
    `📡 Quota: ${quota}\n` +
    `🔐 IP Limit: ${ipLimitText} IP\n` +
    `👥 Akun Terpakai: ${used}/${max || "∞"}\n` +
    `📌 Status: ✅ Tersedia`
  );
}

function formatAccountResult({ domain, password, expiredAt }) {
  // format sesuai request user: domain / password / Expired
  return `✅ <b>Akun berhasil dibuat</b>\n\n` +
    `<b>domain</b>\n<code>${escapeHtml(domain)}</code>\n\n` +
    `<b>password</b>\n<code>${escapeHtml(password)}</code>\n\n` +
    `<b>Expired</b>\n<code>${escapeHtml(expiredAt)}</code>`;
}

// =================== Bot init ===================
ensureConfigFiles();
let UI = loadUI();

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// Log text masuk (buat debug ringan)
bot.use(async (ctx, next) => {
  if (ctx.message?.text) {
    console.log("TEXT_IN:", JSON.stringify(ctx.message.text));
  }
  return next();
});

// =================== /start ===================
bot.start(async (ctx) => {
  const denied = denyIfPrivate(ctx);
  if (denied) return;

  UI = loadUI(); // reload UI in case edited
  upsertUser(ctx.from.id, ctx.from.first_name);

  const uid = ctx.from.id;
  const saldo = getBalance(uid);

  const today = countCreated({ userId: uid, from: startOfDay() });
  const week = countCreated({ userId: uid, from: startOfWeek() });
  const month = countCreated({ userId: uid, from: startOfMonth() });

  const gToday = countCreated({ from: startOfDay() });
  const gWeek = countCreated({ from: startOfWeek() });
  const gMonth = countCreated({ from: startOfMonth() });

  const c = UI.contact || {};

  const brandTitle = UI.brandTitle || "ZIVPN UDP PREMIUM";
  const brandDesc = UI.brandDesc || ["Bot VPN UDP Premium dengan sistem otomatis", "Akses internet cepat & aman"];

  const headerBorder = "────────────────────────────";
  const header =
    `┌ ⚡ <b>${escapeHtml(brandTitle)}</b> ⚡\n` +
    brandDesc.map((x) => `│ ${escapeHtml(x)}`).join("\n") +
    `\n└${headerBorder}`;

  let msg = "";
  msg += header + "\n\n";
  msg += `👋 <b>Hai, ${escapeHtml(ctx.from.first_name || "Member")}!</b>\n\n`;
  msg += `🆔 <b>ID</b>     : <code>${uid}</code>\n`;
  msg += `💰 <b>Saldo</b>  : <b>${escapeHtml(formatRupiah(saldo))}</b>\n`;
  msg += `🧩 <b>Mode</b>   : <b>${escapeHtml(MODE.toUpperCase())}</b>\n\n`;

  msg += `📊 <b>Statistik Anda</b>\n`;
  msg += `• Hari ini   : <b>${today}</b> akun\n`;
  msg += `• Minggu ini : <b>${week}</b> akun\n`;
  msg += `• Bulan ini  : <b>${month}</b> akun\n\n`;

  msg += `🌍 <b>Statistik Global</b>\n`;
  msg += `• Hari ini   : <b>${gToday}</b> akun\n`;
  msg += `• Minggu ini : <b>${gWeek}</b> akun\n`;
  msg += `• Bulan ini  : <b>${gMonth}</b> akun\n\n`;

  msg += `☎️ <b>Bantuan / Kontak</b>\n`;
  if (c.telegram) msg += `• Telegram : ${escapeHtml(c.telegram)}\n`;
  if (c.whatsapp) msg += `• WhatsApp : ${escapeHtml(c.whatsapp)}\n`;
  if (c.text) msg += `• ${escapeHtml(c.text)}\n`;

  return ctx.reply(msg, { parse_mode: "HTML", ...mainKb(ctx) });
});

// =================== Menu handlers (gunakan regex supaya tidak "diam") ===================
bot.hears(/bantuan/i, async (ctx) => {
  const denied = denyIfPrivate(ctx);
  if (denied) return;

  UI = loadUI();
  const c = UI.contact || {};
  let msg = `☎️ <b>Bantuan / Kontak</b>\n`;
  msg += `• Telegram : ${escapeHtml(c.telegram || CONTACT_TELEGRAM)}\n`;
  msg += `• WhatsApp : ${escapeHtml(c.whatsapp || CONTACT_WHATSAPP)}\n`;
  if (c.text) msg += `• ${escapeHtml(c.text)}\n`;
  return ctx.reply(msg, { parse_mode: "HTML", ...mainKb(ctx) });
});

bot.hears(/admin panel/i, async (ctx) => {
  if (!isOwnerOrAdmin(ctx.from.id)) return ctx.reply("❌ Akses ditolak.", mainKb(ctx));
  return ctx.reply("⚙️ <b>Admin Panel</b>", { parse_mode: "HTML", ...adminKb() });
});

bot.hears(/kembali/i, async (ctx) => {
  return ctx.reply("✅ Kembali ke menu.", mainKb(ctx));
});

// =================== Create / Trial / Renew flow (callback-based) ===================
function setFlow(ctx, flow) {
  ctx.session.flow = flow;
}
function getFlow(ctx) {
  return ctx.session.flow || null;
}
function clearFlow(ctx) {
  ctx.session.flow = null;
}

function serverButtons(action) {
  const servers = loadServers();
  const rows = servers.map((s) => [Markup.button.callback(`${s.name} (${s.code})`, `${action}:server:${s.code}`)]);
  rows.push([Markup.button.callback("❌ Batal", `${action}:cancel`)]);
  return Markup.inlineKeyboard(rows);
}

function ipLimitButtons(action, serverCode) {
  const s = getServer(serverCode);
  const ips = s?.ipLimits?.length ? s.ipLimits : [1, 2];
  const rows = ips.map((n) => [Markup.button.callback(`${n} IP`, `${action}:ip:${serverCode}:${n}`)]);
  rows.push([Markup.button.callback("⬅️ Kembali", `${action}:back:servers`)]);
  return Markup.inlineKeyboard(rows);
}

function planButtons(action, serverCode, ipLimit, includeTrial = false) {
  const s = getServer(serverCode);
  const rows = [];
  rows.push([Markup.button.callback(`1 Hari (${formatRupiah(s.prices?.d1 || 0)})`, `${action}:plan:${serverCode}:${ipLimit}:d1`)]);
  rows.push([Markup.button.callback(`14 Hari (${formatRupiah(s.prices?.d14 || 0)})`, `${action}:plan:${serverCode}:${ipLimit}:d14`)]);
  rows.push([Markup.button.callback(`30 Hari (${formatRupiah(s.prices?.d30 || 0)})`, `${action}:plan:${serverCode}:${ipLimit}:d30`)]);
  if (includeTrial) rows.push([Markup.button.callback(`Trial ${TRIAL_HOURS} Jam`, `${action}:plan:${serverCode}:${ipLimit}:trial`)]);
  rows.push([Markup.button.callback("⬅️ Kembali", `${action}:back:ip:${serverCode}`)]);
  rows.push([Markup.button.callback("❌ Batal", `${action}:cancel`)]);
  return Markup.inlineKeyboard(rows);
}

bot.hears(/buat akun/i, async (ctx) => {
  const denied = denyIfPrivate(ctx);
  if (denied) return;

  setFlow(ctx, { type: "create", step: "server" });
  const servers = loadServers();
  if (!servers.length) return ctx.reply("❌ Tidak ada server tersedia. Cek config/servers.json");
  const msg = servers.map(serverInfoText).join("\n\n");
  await ctx.reply(msg);
  return ctx.reply("Pilih server:", serverButtons("create"));
});

bot.hears(/trial akun/i, async (ctx) => {
  const denied = denyIfPrivate(ctx);
  if (denied) return;

  // trial only once per user
  upsertUser(ctx.from.id, ctx.from.first_name);
  const u = getUser(ctx.from.id);
  if (u?.trialUsed) {
    return ctx.reply("❌ Trial sudah pernah digunakan.", mainKb(ctx));
  }

  setFlow(ctx, { type: "trial", step: "server" });
  const servers = loadServers();
  if (!servers.length) return ctx.reply("❌ Tidak ada server tersedia. Cek config/servers.json");
  const msg = servers.map(serverInfoText).join("\n\n");
  await ctx.reply(msg);
  return ctx.reply(`Pilih server untuk Trial (${TRIAL_HOURS} jam):`, serverButtons("trial"));
});

bot.hears(/perpanjang/i, async (ctx) => {
  const denied = denyIfPrivate(ctx);
  if (denied) return;

  const uid = String(ctx.from.id);
  const acc = getAcc().filter((a) => a.status === "active" && String(a.userId) === uid);
  if (!acc.length) return ctx.reply("❌ Kamu belum punya akun aktif.", mainKb(ctx));

  const rows = acc.slice(0, 20).map((a) => [
    Markup.button.callback(`${a.serverCode} • ${a.password} • exp ${a.expiredAt.slice(0, 10)}`, `renew:pick:${a.id}`),
  ]);
  rows.push([Markup.button.callback("❌ Batal", "renew:cancel")]);
  setFlow(ctx, { type: "renew", step: "pick" });
  return ctx.reply("Pilih akun yang ingin diperpanjang:", Markup.inlineKeyboard(rows));
});

bot.hears(/akun saya/i, async (ctx) => {
  const denied = denyIfPrivate(ctx);
  if (denied) return;

  const uid = String(ctx.from.id);
  const acc = getAcc()
    .filter((a) => String(a.userId) === uid)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  if (!acc.length) return ctx.reply("Belum ada akun.", mainKb(ctx));

  const active = acc.filter((a) => a.status === "active");
  const expired = acc.filter((a) => a.status !== "active");

  let msg = `📌 <b>Akun Saya</b>\n\n`;
  if (active.length) {
    msg += `✅ <b>Aktif</b>\n`;
    for (const a of active.slice(0, 15)) {
      const s = getServer(a.serverCode);
      msg += `• ${a.serverCode} | ${escapeHtml(s?.domain || "-")} | <code>${escapeHtml(a.password)}</code> | exp <code>${escapeHtml(a.expiredAt)}</code>\n`;
    }
    msg += `\n`;
  }
  if (expired.length) {
    msg += `⛔ <b>Tidak aktif</b>\n`;
    for (const a of expired.slice(0, 10)) {
      const s = getServer(a.serverCode);
      msg += `• ${a.serverCode} | ${escapeHtml(s?.domain || "-")} | <code>${escapeHtml(a.password)}</code> | exp <code>${escapeHtml(a.expiredAt)}</code>\n`;
    }
  }

  return ctx.reply(msg, { parse_mode: "HTML", ...mainKb(ctx) });
});

// =================== Callbacks: create/trial ===================
bot.on("callback_query", async (ctx) => {
  try {
    const data = String(ctx.callbackQuery?.data || "");
    // ack fast
    await ctx.answerCbQuery().catch(() => {});

    // CANCEL / BACK
    if (data.endsWith(":cancel")) {
      clearFlow(ctx);
      return ctx.reply("✅ Dibatalkan.", mainKb(ctx));
    }
    if (data.includes(":back:servers")) {
      const action = data.split(":")[0];
      return ctx.editMessageText("Pilih server:", serverButtons(action)).catch(() => {});
    }
    if (data.startsWith("create:back:ip:") || data.startsWith("trial:back:ip:")) {
      const [action, , , serverCode] = data.split(":");
      return ctx.editMessageText("Pilih IP Limit:", ipLimitButtons(action, serverCode)).catch(() => {});
    }

    // RENEW CANCEL
    if (data === "renew:cancel") {
      clearFlow(ctx);
      return ctx.reply("✅ Dibatalkan.", mainKb(ctx));
    }

    // RENEW PICK
    if (data.startsWith("renew:pick:")) {
      const id = data.split(":")[2];
      const acc = getAcc().find((a) => a.id === id && a.status === "active" && String(a.userId) === String(ctx.from.id));
      if (!acc) return ctx.reply("❌ Akun tidak ditemukan / sudah tidak aktif.", mainKb(ctx));

      const s = getServer(acc.serverCode);
      const ipLimit = acc.ipLimit || 1;

      setFlow(ctx, { type: "renew", step: "plan", accountId: id });
      return ctx.reply(
        `Pilih durasi perpanjang untuk <code>${escapeHtml(acc.password)}</code>\nServer: ${escapeHtml(s?.name || acc.serverCode)}\nIP Limit: ${ipLimit}`,
        { parse_mode: "HTML", ...planButtons("renew", acc.serverCode, ipLimit, false).reply_markup }
      );
    }

    // CREATE/TRIAL: pick server
    if (data.startsWith("create:server:") || data.startsWith("trial:server:")) {
      const [action, , , serverCode] = data.split(":");
      const s = getServer(serverCode);
      if (!s) return ctx.reply("❌ Server tidak valid.", mainKb(ctx));
      setFlow(ctx, { type: action, step: "ip", serverCode });
      return ctx.editMessageText("Pilih IP Limit:", ipLimitButtons(action, serverCode)).catch(() => {});
    }

    // CREATE/TRIAL: pick ip
    if (data.startsWith("create:ip:") || data.startsWith("trial:ip:")) {
      const [action, , serverCode, ipLimit] = data.split(":");
      const s = getServer(serverCode);
      if (!s) return ctx.reply("❌ Server tidak valid.", mainKb(ctx));
      setFlow(ctx, { type: action, step: "plan", serverCode, ipLimit: Number(ipLimit) });
      return ctx.editMessageText("Pilih durasi:", planButtons(action, serverCode, Number(ipLimit), action === "trial")).catch(() => {});
    }

    // CREATE/TRIAL: pick plan
    if (data.startsWith("create:plan:") || data.startsWith("trial:plan:")) {
      const [action, , serverCode, ipLimit, plan] = data.split(":");
      const s = getServer(serverCode);
      if (!s) return ctx.reply("❌ Server tidak valid.", mainKb(ctx));
      if (action === "trial" && plan !== "trial") {
        return ctx.reply("❌ Trial hanya untuk opsi Trial.", mainKb(ctx));
      }
      setFlow(ctx, { type: action, step: "password", serverCode, ipLimit: Number(ipLimit), plan });
      return ctx.reply(
        `Kirim <b>password</b> yang ingin dipakai.\nSyarat: unik (tidak boleh sama).\n\nServer: <b>${escapeHtml(s.name)}</b>\nDomain: <code>${escapeHtml(s.domain)}</code>\nIP Limit: <b>${ipLimit}</b>\nDurasi: <b>${escapeHtml(planLabel(plan))}</b>`,
        { parse_mode: "HTML", ...mainKb(ctx) }
      );
    }

    // RENEW: plan chosen
    if (data.startsWith("renew:plan:")) {
      const [, , serverCode, ipLimit, plan] = data.split(":");
      const flow = getFlow(ctx);
      if (!flow || flow.type !== "renew" || flow.step !== "plan") return;

      const accAll = getAcc();
      const idx = accAll.findIndex((a) => a.id === flow.accountId && a.status === "active" && String(a.userId) === String(ctx.from.id));
      if (idx === -1) return ctx.reply("❌ Akun tidak ditemukan.", mainKb(ctx));

      const s = getServer(serverCode);
      const price = Number(s?.prices?.[plan] || 0);

      if (MODE === "paid") {
        const bal = getBalance(ctx.from.id);
        if (bal < price) {
          return ctx.reply(`❌ Saldo tidak cukup.\nSaldo: ${formatRupiah(bal)}\nHarga: ${formatRupiah(price)}\nSilakan TopUp dulu.`, mainKb(ctx));
        }
        setBalance(ctx.from.id, bal - price);
      }

      // extend expiry
      const oldExp = accAll[idx].expiredAt;
      const base = Math.max(Date.parse(oldExp), Date.now());
      let addMs = 0;
      if (plan === "d1") addMs = 1 * 86400 * 1000;
      if (plan === "d14") addMs = 14 * 86400 * 1000;
      if (plan === "d30") addMs = 30 * 86400 * 1000;
      const newExp = new Date(base + addMs).toISOString();

      accAll[idx].expiredAt = newExp;
      accAll[idx].updatedAt = nowISO();
      setAcc(accAll);

      clearFlow(ctx);
      const domain = s?.domain || "-";
      return ctx.reply(
        `✅ <b>Perpanjang berhasil</b>\n\nDomain: <code>${escapeHtml(domain)}</code>\nPassword: <code>${escapeHtml(accAll[idx].password)}</code>\nExpired: <code>${escapeHtml(newExp)}</code>`,
        { parse_mode: "HTML", ...mainKb(ctx) }
      );
    }
  } catch (e) {
    console.error("CALLBACK ERROR:", e);
    return ctx.reply("❌ Terjadi error di callback.", mainKb(ctx));
  }
});

// =================== TopUp (paid mode) ===================
bot.hears(/topup/i, async (ctx) => {
  const denied = denyIfPrivate(ctx);
  if (denied) return;

  if (MODE !== "paid") return ctx.reply("❌ Fitur TopUp hanya untuk mode PAID.", mainKb(ctx));
  if (!PAKASIR_PROJECT || !PAKASIR_API_KEY) return ctx.reply("❌ Pakasir belum dikonfigurasi (PAKASIR_PROJECT/API_KEY).");

  ctx.session.topup = { step: "amount" };
  return ctx.reply(`Masukkan nominal TopUp (min ${formatRupiah(TOPUP_MIN)}).\nContoh: 10000`, mainKb(ctx));
});

// =================== Admin Panel handlers ===================
bot.hears(/list akun aktif/i, async (ctx) => {
  if (!isOwnerOrAdmin(ctx.from.id)) return ctx.reply("❌ Akses ditolak.", mainKb(ctx));
  const acc = getAcc().filter((a) => a.status === "active").sort((a, b) => Date.parse(a.expiredAt) - Date.parse(b.expiredAt));
  if (!acc.length) return ctx.reply("Tidak ada akun aktif.", adminKb());

  let msg = `📋 <b>List Akun Aktif</b>\nTotal: ${acc.length}\n\n`;
  for (const a of acc.slice(0, 25)) {
    const s = getServer(a.serverCode);
    msg += `• UID ${a.userId} | ${a.serverCode} | ${escapeHtml(s?.domain || "-")} | <code>${escapeHtml(a.password)}</code> | exp <code>${escapeHtml(a.expiredAt)}</code>\n`;
  }
  msg += acc.length > 25 ? `\n...dan ${acc.length - 25} lainnya` : "";
  return ctx.reply(msg, { parse_mode: "HTML", ...adminKb() });
});

bot.hears(/cari akun/i, async (ctx) => {
  if (!isOwnerOrAdmin(ctx.from.id)) return ctx.reply("❌ Akses ditolak.", mainKb(ctx));
  ctx.session.adminFind = { step: "password" };
  return ctx.reply("Kirim password yang ingin dicari:", adminKb());
});

bot.hears(/delete akun/i, async (ctx) => {
  if (!isOwnerOrAdmin(ctx.from.id)) return ctx.reply("❌ Akses ditolak.", mainKb(ctx));
  ctx.session.adminDel = { step: "pair" };
  return ctx.reply("Format hapus: <user_id> <password>\nContoh: 5688411076 eko12345", adminKb());
});

bot.hears(/tambah saldo user/i, async (ctx) => {
  if (!isOwnerOrAdmin(ctx.from.id)) return ctx.reply("❌ Akses ditolak.", mainKb(ctx));
  ctx.session.adminAddSaldo = { step: "pair" };
  return ctx.reply("Format: <user_id> <nominal>\nContoh: 5688411076 20000", adminKb());
});

bot.hears(/cek saldo user/i, async (ctx) => {
  if (!isOwnerOrAdmin(ctx.from.id)) return ctx.reply("❌ Akses ditolak.", mainKb(ctx));
  ctx.session.adminCheckSaldo = { step: "userid" };
  return ctx.reply("Kirim user_id (angka) untuk cek saldo.\nContoh: 5688411076", adminKb());
});

// =================== Text handler (flows) ===================
// PENTING: jangan blok tombol menu -> gunakan next()
bot.on("text", async (ctx, next) => {
  try {
    const denied = denyIfPrivate(ctx);
    if (denied) return;

    const text = String(ctx.message.text || "").trim();
    upsertUser(ctx.from.id, ctx.from.first_name);

    // Biarkan hears / callback handle menu
    if (/buat akun/i.test(text) || /trial akun/i.test(text) || /perpanjang/i.test(text) || /akun saya/i.test(text) || /topup/i.test(text) || /admin panel/i.test(text) || /bantuan/i.test(text) || /kembali/i.test(text)) {
      return next();
    }

    // ===== Admin find =====
    if (ctx.session.adminFind?.step === "password" && isOwnerOrAdmin(ctx.from.id)) {
      ctx.session.adminFind = null;
      const pass = text;
      const acc = getAcc().find((a) => a.password === pass);
      if (!acc) return ctx.reply("❌ Akun tidak ditemukan.", adminKb());
      const s = getServer(acc.serverCode);
      return ctx.reply(
        `🔎 <b>Detail Akun</b>\nUID: <code>${escapeHtml(acc.userId)}</code>\nServer: <b>${escapeHtml(acc.serverCode)}</b>\nDomain: <code>${escapeHtml(s?.domain || "-")}</code>\nPassword: <code>${escapeHtml(acc.password)}</code>\nStatus: <b>${escapeHtml(acc.status)}</b>\nExpired: <code>${escapeHtml(acc.expiredAt)}</code>\nIP Limit: <b>${acc.ipLimit || 1}</b>`,
        { parse_mode: "HTML", ...adminKb() }
      );
    }

    // ===== Admin delete =====
    if (ctx.session.adminDel?.step === "pair" && isOwnerOrAdmin(ctx.from.id)) {
      ctx.session.adminDel = null;
      const parts = text.split(/\s+/);
      if (parts.length < 2) return ctx.reply("Format salah.\nGunakan: <user_id> <password>", adminKb());

      const uid = parts[0];
      const pass = parts.slice(1).join(" ");

      if (!/^\d+$/.test(uid)) return ctx.reply("user_id harus angka.", adminKb());

      const all = getAcc();
      const idx = all.findIndex((a) => a.status === "active" && String(a.userId) === String(uid) && a.password === pass);
      if (idx === -1) return ctx.reply("❌ Akun tidak ditemukan / sudah tidak aktif.", adminKb());

      // delete
      all[idx].status = "deleted";
      all[idx].deletedAt = nowISO();
      all[idx].updatedAt = nowISO();
      setAcc(all);

      // remove password from zivpn
      try { await passDel(pass); } catch (e) { console.error("passDel error:", e); }

      return ctx.reply(`✅ Akun user ${uid} (password ${pass}) sudah dihapus.`, adminKb());
    }

    // ===== Admin add saldo =====
    if (ctx.session.adminAddSaldo?.step === "pair" && isOwnerOrAdmin(ctx.from.id)) {
      ctx.session.adminAddSaldo = null;
      const parts = text.split(/\s+/);
      if (parts.length < 2) return ctx.reply("Format salah.\nGunakan: <user_id> <nominal>", adminKb());

      const uid = parts[0];
      const amt = Number(parts[1]);
      if (!/^\d+$/.test(uid)) return ctx.reply("user_id harus angka.", adminKb());
      if (!Number.isFinite(amt) || amt <= 0) return ctx.reply("Nominal tidak valid.", adminKb());

      upsertUser(uid, "");
      addBalance(uid, amt);
      return ctx.reply(`✅ Saldo user ${uid} ditambah ${formatRupiah(amt)}.\nSaldo sekarang: ${formatRupiah(getBalance(uid))}`, adminKb());
    }

    // ===== Admin check saldo =====
    if (ctx.session.adminCheckSaldo?.step === "userid" && isOwnerOrAdmin(ctx.from.id)) {
      ctx.session.adminCheckSaldo = null;
      const uid = text.trim();
      if (!/^\d+$/.test(uid)) return ctx.reply("user_id harus angka.", adminKb());

      const u = getUser(uid);
      const saldo = u ? Number(u.balance || 0) : 0;
      const trialUsed = u ? (u.trialUsed ? "Ya" : "Belum") : "-";
      const createdAt = u?.createdAt || "-";

      return ctx.reply(
        `💰 <b>Saldo User</b>\nUserID: <code>${uid}</code>\nSaldo: <b>${escapeHtml(formatRupiah(saldo))}</b>\nTrial digunakan: <b>${trialUsed}</b>\nTerdaftar: <code>${escapeHtml(createdAt)}</code>`,
        { parse_mode: "HTML", ...adminKb() }
      );
    }

    // ===== TopUp flow =====
    if (ctx.session.topup?.step === "amount") {
      if (MODE !== "paid") {
        ctx.session.topup = null;
        return ctx.reply("❌ Mode bukan PAID.", mainKb(ctx));
      }
      const amt = Number(text.replace(/[^\d]/g, ""));
      if (!Number.isFinite(amt) || amt < TOPUP_MIN) {
        return ctx.reply(`Nominal minimal ${formatRupiah(TOPUP_MIN)}.\nContoh: 10000`, mainKb(ctx));
      }

      const orderId = randId(`TOPUP-${ctx.from.id}`);
      const payList = getPayments();
      payList.push({
        id: orderId,
        userId: String(ctx.from.id),
        amount: amt,
        type: "topup",
        status: "pending",
        createdAt: nowISO(),
      });
      setPayments(payList);

      // Create QRIS
      try {
        const payment = await pakasirCreateQRIS({ orderId, amount: amt }); // payment_number + expired_at :contentReference[oaicite:3]{index=3}
        const qrStr = payment.payment_number;
        const exp = payment.expired_at;

        const png = await qrToPngBuffer(qrStr);
        await ctx.replyWithPhoto({ source: png }, {
          caption:
            `💳 <b>TopUp Saldo</b>\n` +
            `OrderID: <code>${escapeHtml(orderId)}</code>\n` +
            `Nominal: <b>${escapeHtml(formatRupiah(amt))}</b>\n` +
            `Expired: <code>${escapeHtml(exp)}</code>\n\n` +
            `Silakan scan QRIS. Setelah bayar, saldo masuk otomatis.`,
          parse_mode: "HTML",
        });

        ctx.session.topup = null;
        return;
      } catch (e) {
        console.error("Topup create error:", e);
        ctx.session.topup = null;
        return ctx.reply("❌ Gagal membuat QRIS TopUp. Cek konfigurasi Pakasir.", mainKb(ctx));
      }
    }

    // ===== Create/Trial: waiting password =====
    const flow = getFlow(ctx);
    if (flow && (flow.type === "create" || flow.type === "trial") && flow.step === "password") {
      const server = getServer(flow.serverCode);
      if (!server) {
        clearFlow(ctx);
        return ctx.reply("❌ Server tidak valid.", mainKb(ctx));
      }

      const pass = text;
      if (pass.length < 3) return ctx.reply("Password terlalu pendek. Minimal 3 karakter.");

      // must be unique
      if (passwordUsedInAccounts(pass)) return ctx.reply("❌ Password sudah dipakai akun lain. Pakai password lain.");
      const exists = await passCheck(pass);
      if (exists) return ctx.reply("❌ Password sudah ada di server. Pakai password lain.");

      const plan = flow.plan;
      if (flow.type === "trial") {
        const u = getUser(ctx.from.id);
        if (u?.trialUsed) {
          clearFlow(ctx);
          return ctx.reply("❌ Trial sudah pernah digunakan.", mainKb(ctx));
        }
      }

      // PRICE & BALANCE (paid mode only)
      const price = plan === "trial" ? 0 : Number(server.prices?.[plan] || 0);
      if (MODE === "paid" && plan !== "trial") {
        const bal = getBalance(ctx.from.id);
        if (bal < price) {
          return ctx.reply(`❌ Saldo tidak cukup.\nSaldo: ${formatRupiah(bal)}\nHarga: ${formatRupiah(price)}\nSilakan TopUp dulu.`, mainKb(ctx));
        }
        setBalance(ctx.from.id, bal - price);
      }

      // Create on ZiVPN (add password)
      try {
        await passAdd(pass);
      } catch (e) {
        console.error("passAdd error:", e);
        // refund if paid
        if (MODE === "paid" && plan !== "trial") addBalance(ctx.from.id, price);
        return ctx.reply("❌ Gagal membuat akun di server. Cek zivpn-passwd-manager.", mainKb(ctx));
      }

      const expiredAt = planExpireAt(plan);
      const acc = getAcc();
      const id = randId("ACC");
      acc.push({
        id,
        userId: String(ctx.from.id),
        serverCode: server.code,
        domain: server.domain,
        password: pass,
        ipLimit: Number(flow.ipLimit || 1),
        plan,
        status: "active",
        createdAt: nowISO(),
        updatedAt: nowISO(),
        expiredAt,
      });
      setAcc(acc);
      pushCreateStat(ctx.from.id);

      if (flow.type === "trial") {
        // mark trial used
        const users = getUsers();
        const idx = users.findIndex((u) => String(u.userId) === String(ctx.from.id));
        if (idx !== -1) {
          users[idx].trialUsed = true;
          users[idx].updatedAt = nowISO();
          setUsers(users);
        }
      }

      clearFlow(ctx);

      return ctx.reply(formatAccountResult({ domain: server.domain, password: pass, expiredAt }), {
        parse_mode: "HTML",
        ...mainKb(ctx),
      });
    }

    return next();
  } catch (e) {
    console.error("TEXT FLOW ERROR:", e);
    return ctx.reply("❌ Terjadi error saat memproses input.", mainKb(ctx));
  }
});

// =================== Webhook Server (Pakasir) ===================
const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    // token check via query ?token=
    const token = String(req.query?.token || "");
    if (WEBHOOK_TOKEN && token !== WEBHOOK_TOKEN) {
      return res.status(403).json({ ok: false, error: "bad token" });
    }

    const body = req.body || {};
    // docs payload: { amount, order_id, project, status, payment_method, completed_at } :contentReference[oaicite:4]{index=4}
    const amount = Number(body.amount || 0);
    const orderId = String(body.order_id || "");
    const status = String(body.status || "");

    if (!orderId || !amount) return res.json({ ok: true });

    // find payment
    const payList = getPayments();
    const idx = payList.findIndex((p) => String(p.id) === orderId && p.status === "pending");
    if (idx === -1) return res.json({ ok: true });

    // validasi lebih kuat: cek transactiondetail (recommended) :contentReference[oaicite:5]{index=5}
    let detail = null;
    try {
      detail = await pakasirDetail({ orderId, amount });
    } catch (e) {
      console.error("pakasirDetail error:", e);
    }

    const completed =
      status === "completed" ||
      status === "success" ||
      (detail && String(detail.status || "") === "completed");

    if (!completed) return res.json({ ok: true });

    const pay = payList[idx];
    payList[idx].status = "completed";
    payList[idx].completedAt = nowISO();
    setPayments(payList);

    // credit balance for topup
    if (pay.type === "topup") {
      addBalance(pay.userId, pay.amount);

      // notify user
      try {
        await bot.telegram.sendMessage(
          pay.userId,
          `✅ <b>TopUp berhasil</b>\nNominal: <b>${escapeHtml(formatRupiah(pay.amount))}</b>\nSaldo sekarang: <b>${escapeHtml(formatRupiah(getBalance(pay.userId)))}</b>`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        console.error("notify user topup error:", e);
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    return res.status(500).json({ ok: false });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Webhook listening on 127.0.0.1:${PORT}${WEBHOOK_PATH}`);
});

// =================== Expiry cleanup job ===================
async function cleanupExpired() {
  const all = getAcc();
  let changed = false;

  for (const a of all) {
    if (a.status === "active" && a.expiredAt && isExpired(a.expiredAt)) {
      a.status = "expired";
      a.updatedAt = nowISO();
      changed = true;
      try {
        await passDel(a.password);
      } catch (e) {
        console.error("passDel expired error:", e);
      }
      try {
        await bot.telegram.sendMessage(
          a.userId,
          `⛔ <b>Akun expired</b>\nDomain: <code>${escapeHtml(a.domain || "-")}</code>\nPassword: <code>${escapeHtml(a.password)}</code>\nExpired: <code>${escapeHtml(a.expiredAt)}</code>`,
          { parse_mode: "HTML" }
        );
      } catch (e) {}
    }
  }

  if (changed) setAcc(all);
}
setInterval(() => cleanupExpired().catch(() => {}), 5 * 60 * 1000);

// =================== Start bot ===================
(async () => {
  try {
    await bot.telegram.getMe();
    console.log("Bot started OK");
  } catch (e) {
    console.error("UNHANDLED:", e);
  }

  bot.launch().then(() => console.log("Telegraf launch done")).catch((e) => console.error("launch error:", e));

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
})();
