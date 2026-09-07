// license.js — 90-day trial + machine-bound HMAC activation.
//  - 首次启动记录 installedAt（license.json 与 DB app_meta 双写镜像），
//    90 天后未激活进入受限模式；删除单侧文件无法重置试用期。
//  - 激活码 = HMAC-SHA256(secret, machineCode)，一机一码；换机/拷贝无效。
//  - 机器码取自 Windows MachineGuid + 网卡 MAC + 主机名（稳定、难伪造）。
//  - secret 解析顺序：env ATEQ_LICENSE_SECRET -> data/license.secret 文件 -> 内置开发密钥。
//    正式交付务必用 ATEQ_LICENSE_SECRET 或 data/license.secret 配置独立密钥，
//    并配合 tools/gen-license.js（同密钥）离线发码，不要把真实密钥提交到公开仓库。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');
const SECRET_FILE = path.join(DATA_DIR, 'license.secret');
const META_KEY = 'license.v1';

const TRIAL_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let secretCache = null;
let machineCodeCache = null;
let statusCache = null;
let statusCacheAt = 0;
const CACHE_TTL_MS = 1500;

/* ---------------- secret ---------------- */
// 密钥优先级：env ATEQ_LICENSE_SECRET -> data/license.secret（首次运行自动生成随机密钥，
// 已被 .gitignore 忽略，不会进公开仓库）-> 兜底仅用于无法落盘的极端情况。
function getSecret() {
  if (secretCache) return secretCache;
  if (process.env.ATEQ_LICENSE_SECRET) {
    secretCache = String(process.env.ATEQ_LICENSE_SECRET).trim();
    return secretCache;
  }
  try {
    ensureDataDir();
    if (fs.existsSync(SECRET_FILE)) {
      const value = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (value) {
        secretCache = value;
        return secretCache;
      }
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, generated, 'utf8');
    secretCache = generated;
    return secretCache;
  } catch (error) {
    // 磁盘不可写时的极端兜底（不推荐用于正式交付）
    secretCache = 'ATEQ-D620-FALLBACK-2026';
    return secretCache;
  }
}

/* ---------------- machine code ---------------- */

function getMachineGuid() {
  try {
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    );
    const match = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F\-]+)/.exec(out);
    return match ? match[1].toUpperCase() : '';
  } catch (error) {
    return '';
  }
}

function getMacs() {
  const macs = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const entry of ifaces[name]) {
        if (entry && !entry.internal && entry.mac && entry.mac !== '00:00:00:00:00:00') {
          macs.push(entry.mac.toUpperCase());
        }
      }
    }
  } catch (error) {
    // ignore
  }
  return [...new Set(macs)].sort();
}

function getMachineCode() {
  if (machineCodeCache) return machineCodeCache;
  // 优先使用 Windows MachineGuid：随系统安装唯一且稳定，不受网卡增删影响。
  const guid = getMachineGuid();
  let raw;
  if (guid) {
    raw = `ATEQ-D620|GUID|${guid}`;
  } else {
    const parts = [os.hostname().toUpperCase(), getMacs().join('|')];
    raw = `ATEQ-D620|${parts.join('|')}`;
  }
  const digest = crypto
    .createHash('sha256')
    .update(raw, 'utf8')
    .digest('hex')
    .toUpperCase();
  machineCodeCache = digest.slice(0, 32);
  return machineCodeCache;
}

function formatMachineCode(code) {
  const raw = String(code || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  const groups = [];
  for (let i = 0; i < raw.length; i += 4) groups.push(raw.slice(i, i + 4));
  return groups.join('-');
}

/* ---------------- activation code ---------------- */

function computeActivationCode(machineCode, secret) {
  const key = secret || getSecret();
  const digest = crypto
    .createHmac('sha256', String(key))
    .update(`ATEQ-LICENSE|${String(machineCode || '').toUpperCase()}`, 'utf8')
    .digest('hex')
    .toUpperCase();
  return digest.slice(0, 20);
}

function formatActivationCode(code) {
  const raw = String(code || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  const groups = [];
  for (let i = 0; i < raw.length; i += 5) groups.push(raw.slice(i, i + 5));
  return groups.join('-');
}

function normalizeCode(value) {
  return String(value || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}

function codesEqual(a, b) {
  const left = normalizeCode(a);
  const right = normalizeCode(b);
  if (!left || !right || left.length !== right.length) return false;
  const leftBuf = Buffer.from(left, 'utf8');
  const rightBuf = Buffer.from(right, 'utf8');
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

/* ---------------- persistence helpers ---------------- */

let dbApi = null;

async function ensureDb() {
  if (dbApi) return dbApi;
  const db = require('./db');
  dbApi = {
    get: (key) => db.getAppMeta(key),
    set: (key, value) => db.setAppMeta(key, value),
  };
  return dbApi;
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (error) {
    // ignore
  }
}

function readFileState() {
  try {
    if (fs.existsSync(LICENSE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.installedAt) return parsed;
    }
  } catch (error) {
    // ignore
  }
  return null;
}

function writeFileState(state) {
  ensureDataDir();
  try {
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    // ignore
  }
}

async function readDbState() {
  try {
    const api = await ensureDb();
    const raw = await api.get(META_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.installedAt) return parsed;
    }
  } catch (error) {
    // DB may not be ready yet
  }
  return null;
}

async function writeDbState(state) {
  try {
    const api = await ensureDb();
    await api.set(META_KEY, JSON.stringify(state));
  } catch (error) {
    // DB not ready — file copy is authoritative enough at that point
  }
}

// 双源合并：installedAt 取两者中最早（防删文件/清库单侧重置）；activated 任一为真。
async function loadState() {
  const file = readFileState();
  const db = await readDbState();
  const now = new Date().toISOString();
  const state = { installedAt: now, activated: false, activationCode: null };

  const candidates = [];
  if (file && file.installedAt) candidates.push(file.installedAt);
  if (db && db.installedAt) candidates.push(db.installedAt);
  if (candidates.length) {
    candidates.sort((a, b) => Date.parse(a) - Date.parse(b));
    state.installedAt = candidates[0];
  }
  if (file && file.activated) { state.activated = true; state.activationCode = file.activationCode; }
  if (db && db.activated) { state.activated = true; state.activationCode = db.activationCode; }

  if (!file) writeFileState(state);
  if (!db) await writeDbState(state);
  return state;
}

async function persistState(state) {
  writeFileState(state);
  await writeDbState(state);
}

/* ---------------- public API ---------------- */

async function ensureInstalled() {
  await loadState(); // 补齐缺失的镜像侧
}

async function getLicenseStatus() {
  const now = Date.now();
  if (statusCache && now - statusCacheAt < CACHE_TTL_MS) return statusCache;

  const state = await loadState();
  const installedMs = Date.parse(state.installedAt) || now;
  const expiresMs = installedMs + TRIAL_DAYS * MS_PER_DAY;
  const codeOk = codesEqual(state.activationCode, computeActivationCode(getMachineCode()));

  let mode = 'trial';
  if (state.activated && codeOk) {
    mode = 'full';
  } else if (now >= expiresMs) {
    mode = 'expired';
  }
  const daysLeft = Math.max(0, Math.floor((expiresMs - now) / MS_PER_DAY));

  const status = {
    success: true,
    license: {
      mode, // 'trial' | 'full' | 'expired'
      activated: mode === 'full',
      trialDays: TRIAL_DAYS,
      installedAt: new Date(installedMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      daysLeft,
      machineCode: getMachineCode(),
      machineCodeDisplay: formatMachineCode(getMachineCode()),
    },
  };
  statusCache = status;
  statusCacheAt = now;
  return status;
}

async function activate(code) {
  const state = await loadState();
  const expected = computeActivationCode(getMachineCode());
  if (!codesEqual(code, expected)) {
    return { ok: false, message: '激活码无效或与当前机器不匹配，请核对后重试。' };
  }
  state.activated = true;
  state.activationCode = formatActivationCode(expected);
  await persistState(state);
  statusCache = null;
  return { ok: true };
}

// 厂家交付/测试用：清空 license 文件与 DB 镜像，重新开始试用（等价于全新安装）。
async function resetLicense() {
  try {
    if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE);
  } catch (error) { /* ignore */ }
  try {
    const api = await ensureDb();
    await api.set(META_KEY, '');
  } catch (error) { /* ignore */ }
  statusCache = null;
  machineCodeCache = null;
  return { ok: true };
}

module.exports = {
  getSecret,
  getMachineCode,
  formatMachineCode,
  computeActivationCode,
  formatActivationCode,
  getLicenseStatus,
  activate,
  ensureInstalled,
  resetLicense,
};
