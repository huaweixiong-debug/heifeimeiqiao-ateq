const fs = require('fs');
const path = require('path');
const { normalizeUnitLabel, decodeResultCode, decodeErrorCode, deriveErrorText } = require('./modbusService');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'ateq.db');
const JSON_PATH = path.join(DATA_DIR, 'runtime-store.json');

let db = null;

/* ---------- SQLite helpers ---------- */

function execAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push([...stmt.get()]); // clone 鈥?sql.js reuses internal buffer
  }
  stmt.free();
  return rows;
}

function execOne(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  let row = null;
  if (stmt.step()) row = [...stmt.get()];
  stmt.free();
  return row;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  stmt.step();
  stmt.free();
}

/* ---------- helpers ---------- */

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeKey(value) {
  return String(value || '').trim().toUpperCase();
}

function todayDateText() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

const LEGACY_SIGNED32_SCALE_OFFSET = 4294967.296;
const ZERO_PRESSURE_ZERO_LEAK_MARKER = 9999;

function normalizeLegacyLeakValue(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return value;
  }

  if (numericValue <= -1000000 && numericValue > -5000000) {
    const corrected = numericValue + LEGACY_SIGNED32_SCALE_OFFSET;
    if (Math.abs(corrected) < 10000) {
      return Number(corrected.toFixed(6));
    }
  }

  return numericValue;
}

function isZeroMetricValue(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && Math.abs(numericValue) < 0.0000005;
}

function isZeroOrMissingMetricValue(value) {
  return value === null || value === undefined || value === '' || isZeroMetricValue(value);
}

function normalizeFinalLeakValue(finalPressure, finalLeak) {
  if (isZeroOrMissingMetricValue(finalPressure) && isZeroMetricValue(finalLeak)) {
    return ZERO_PRESSURE_ZERO_LEAK_MARKER;
  }

  return normalizeLegacyLeakValue(finalLeak);
}

async function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

/* ---------- init ---------- */

async function initDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
    createTables();
    await migrateFromJson();
    await persist();
  }
  ensureColumns();
}

function ensureColumns() {
  run('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');

  try { run('ALTER TABLE product_profiles ADD COLUMN fill_time REAL'); } catch(e) {}
  try { run('ALTER TABLE product_profiles ADD COLUMN stab_time REAL'); } catch(e) {}
  try { run('ALTER TABLE product_profiles ADD COLUMN test_time REAL'); } catch(e) {}
  try { run('ALTER TABLE product_profiles ADD COLUMN scan_confirm_enabled INTEGER DEFAULT 1'); } catch(e) {}
  try { run('ALTER TABLE product_profiles ADD COLUMN scan_auto_start_enabled INTEGER DEFAULT 0'); } catch(e) {}
  try { run('ALTER TABLE product_profiles ADD COLUMN scan_match_enabled INTEGER'); } catch(e) {}
  try { run('UPDATE product_profiles SET scan_match_enabled = scan_auto_start_enabled WHERE scan_match_enabled IS NULL'); } catch(e) {}
}

function createTables() {
  run(`CREATE TABLE IF NOT EXISTS comm_configs (
    device_type TEXT PRIMARY KEY, com_port TEXT, baudrate INTEGER, data_bits INTEGER,
    parity TEXT, stop_bits REAL, slave_id INTEGER, timeout_ms INTEGER,
    poll_interval_ms INTEGER, dtr INTEGER, rts INTEGER, enabled INTEGER, updated_at TEXT)`);
  run(`CREATE TABLE IF NOT EXISTS operators (
    id TEXT PRIMARY KEY, name TEXT, is_active INTEGER, updated_at TEXT)`);
  run(`CREATE TABLE IF NOT EXISTS product_profiles (
    id TEXT PRIMARY KEY, product_model TEXT, ateq_program_no INTEGER,
    qr_keyword TEXT, is_active INTEGER, updated_at TEXT,
    fill_time REAL, stab_time REAL, test_time REAL,
    scan_confirm_enabled INTEGER, scan_auto_start_enabled INTEGER,
    scan_match_enabled INTEGER)`);
  run(`CREATE TABLE IF NOT EXISTS scanner_events (
    id TEXT PRIMARY KEY, raw_text TEXT, scanned_at TEXT)`);
  run(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
  run(`CREATE TABLE IF NOT EXISTS test_records (
    id TEXT PRIMARY KEY, batch_date TEXT, daily_sequence INTEGER,
    sequence_code TEXT, started_at TEXT, finished_at TEXT,
    start_mode TEXT, qr_code TEXT, product_id TEXT, product_model TEXT,
    ateq_program_no INTEGER, operator_name TEXT,
    test_pressure REAL, final_pressure REAL, pressure_unit TEXT,
    final_leak REAL, leak_unit TEXT, result_code TEXT, error_code TEXT,
    raw_status_word INTEGER, sample_count INTEGER, samples TEXT, updated_at TEXT)`);
}

async function migrateFromJson() {
  if (!fs.existsSync(JSON_PATH)) return;
  let store;
  try { store = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); } catch { return; }
  const now = new Date().toISOString();

  if (store.commConfigs) {
    const ins = db.prepare(`INSERT OR REPLACE INTO comm_configs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [type, cfg] of Object.entries(store.commConfigs)) {
      ins.bind([type, cfg.comPort||'COM1', cfg.baudrate||9600, cfg.dataBits||8,
        cfg.parity||'none', cfg.stopBits||1, cfg.slaveId||null, cfg.timeoutMs||5000,
        cfg.pollIntervalMs||100, cfg.dtr!==false?1:0, cfg.rts!==false?1:0, cfg.enabled!==false?1:0, cfg.updatedAt||now]);
      ins.step(); ins.reset();
    }
    ins.free();
  }

  if (Array.isArray(store.operators)) {
    const ins = db.prepare(`INSERT OR REPLACE INTO operators VALUES (?,?,?,?)`);
    for (const o of store.operators) {
      ins.bind([o.id, o.name, o.isActive!==false?1:0, o.updatedAt||now]);
      ins.step(); ins.reset();
    }
    ins.free();
  }

  if (Array.isArray(store.productProfiles)) {
    const ins = db.prepare(`INSERT OR REPLACE INTO product_profiles (
      id, product_model, ateq_program_no, qr_keyword, is_active, updated_at,
      fill_time, stab_time, test_time, scan_confirm_enabled, scan_auto_start_enabled, scan_match_enabled
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const p of store.productProfiles) {
      ins.bind([p.id, p.productModel, p.ateqProgramNo, p.qrKeyword, p.isActive!==false?1:0, p.updatedAt||now,
        p.fillTime!=null?p.fillTime:null, p.stabTime!=null?p.stabTime:null, p.testTime!=null?p.testTime:null,
        p.scanConfirmEnabled!==false?1:0, 0, p.scanMatchEnabled===true ? 1 : (p.scanAutoStartEnabled===true?1:0)]);
      ins.step(); ins.reset();
    }
    ins.free();
  }

  if (Array.isArray(store.scannerEvents)) {
    const ins = db.prepare(`INSERT OR REPLACE INTO scanner_events VALUES (?,?,?)`);
    for (const e of store.scannerEvents) {
      ins.bind([e.id, e.rawText, e.scannedAt]);
      ins.step(); ins.reset();
    }
    ins.free();
  }

  if (Array.isArray(store.testRecords)) {
    const ins = db.prepare(`INSERT OR REPLACE INTO test_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of store.testRecords) {
      ins.bind([r.id, r.batchDate||'', r.dailySequence||0, r.sequenceCode||'',
        r.startedAt||'', r.finishedAt||'', r.startMode||'', r.qrCode||'', r.productId||'',
        r.productModel||'', r.ateqProgramNo||0, r.operatorName||'',
        r.testPressure!=null?r.testPressure:null, r.finalPressure!=null?r.finalPressure:null,
        r.pressureUnit||'', r.finalLeak!=null?r.finalLeak:null, r.leakUnit||'',
        r.resultCode||'UNKNOWN', r.errorCode||null, r.rawStatusWord||null,
        r.sampleCount||0, r.samples?JSON.stringify(r.samples):'[]', r.updatedAt||now]);
      ins.step(); ins.reset();
    }
    ins.free();
  }

  console.log(`[db] migrated ${store.testRecords?.length || 0} test records, ${store.operators?.length || 0} operators from JSON`);
}

/* ==================== CRUD ==================== */

// --- comm_configs ---

async function getCommConfig(deviceType) {
  const row = execOne('SELECT * FROM comm_configs WHERE device_type = ?', [deviceType]);
  if (!row) return null;
  return { deviceType: row[0], comPort: row[1], baudrate: row[2], dataBits: row[3],
    parity: row[4], stopBits: row[5], slaveId: row[6], timeoutMs: row[7],
    pollIntervalMs: row[8], dtr: row[9]===1, rts: row[10]===1, enabled: row[11]===1, updatedAt: row[12] };
}

async function saveCommConfig(deviceType, config) {
  const now = new Date().toISOString();
  run(`INSERT OR REPLACE INTO comm_configs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    deviceType, config.comPort, config.baudrate, config.dataBits, config.parity,
    config.stopBits, config.slaveId||null, config.timeoutMs||5000,
    config.pollIntervalMs||100, config.dtr!==false?1:0, config.rts!==false?1:0,
    config.enabled!==false?1:0, now]);
  await persist();
  return getCommConfig(deviceType);
}

// --- operators ---

function rowToOperator(r) {
  return { id: r[0], name: r[1], isActive: r[2]===1, updatedAt: r[3] };
}

async function listOperators() {
  return execAll('SELECT id, name, is_active, updated_at FROM operators').map(rowToOperator);
}

async function saveOperators(operators) {
  run('DELETE FROM operators');
  const ins = db.prepare('INSERT INTO operators VALUES (?,?,?,?)');
  const now = new Date().toISOString();
  for (let i=0; i<operators.length; i++) {
    const o = operators[i];
    ins.bind([o.id||`operator-${i+1}`, o.name, o.isActive!==false?1:0, now]);
    ins.step(); ins.reset();
  }
  ins.free();
  await persist();
  return listOperators();
}

async function getOperatorByName(name) {
  if (!name) return null;
  const r = execOne('SELECT id, name, is_active, updated_at FROM operators WHERE UPPER(name) = ?', [normalizeKey(name)]);
  return r ? rowToOperator(r) : null;
}

// --- product_profiles ---

function rowToProduct(r) {
  return { id: r[0], productModel: r[1], ateqProgramNo: r[2], qrKeyword: r[3],
    isActive: r[4]===1, updatedAt: r[5],
    fillTime: r[6], stabTime: r[7], testTime: r[8],
    scanConfirmEnabled: r[9] !== 0,
    scanAutoStartEnabled: r[10] === 1,
    scanMatchEnabled: (r.length > 11 ? r[11] : r[10]) === 1 };
}

async function listProductProfiles() {
  return execAll('SELECT * FROM product_profiles').map(rowToProduct);
}

async function saveProductProfiles(products) {
  run('DELETE FROM product_profiles');
  const ins = db.prepare(`INSERT INTO product_profiles (
    id, product_model, ateq_program_no, qr_keyword, is_active, updated_at,
    fill_time, stab_time, test_time, scan_confirm_enabled, scan_auto_start_enabled, scan_match_enabled
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const now = new Date().toISOString();
  for (let i=0; i<products.length; i++) {
    const p = products[i];
    ins.bind([p.id||`product-${i+1}`, p.productModel, Number(p.ateqProgramNo), p.qrKeyword,
      p.isActive!==false?1:0, now,
      p.fillTime!=null?p.fillTime:null, p.stabTime!=null?p.stabTime:null, p.testTime!=null?p.testTime:null,
      p.scanConfirmEnabled!==false?1:0, p.scanAutoStartEnabled===true?1:0, p.scanMatchEnabled===true?1:0]);
    ins.step(); ins.reset();
  }
  ins.free();
  await persist();
  return listProductProfiles();
}

async function getProductProfileByModel(model) {
  if (!model) return null;
  const r = execOne('SELECT * FROM product_profiles WHERE UPPER(product_model) = ?', [normalizeKey(model)]);
  return r ? rowToProduct(r) : null;
}

async function getProductProfileByProgramNo(programNo) {
  const normalizedProgramNo = Number(programNo);
  if (!Number.isInteger(normalizedProgramNo) || normalizedProgramNo < 1) {
    return null;
  }

  const r = execOne('SELECT * FROM product_profiles WHERE ateq_program_no = ?', [normalizedProgramNo]);
  return r ? rowToProduct(r) : null;
}

async function matchProductProfileByQr(qrCode) {
  if (!qrCode) return null;
  const normQr = normalizeKey(qrCode);
  const rows = execAll('SELECT * FROM product_profiles WHERE is_active = 1');
  for (const r of rows) {
    if (normQr.includes(normalizeKey(r[3]))) return rowToProduct(r);
  }
  return null;
}

// --- scanner_events ---

async function saveScannerEvent(rawText) {
  const ev = { id: `scan-${Date.now()}`, rawText, scannedAt: new Date().toISOString() };
  run('INSERT INTO scanner_events VALUES (?,?,?)', [ev.id, ev.rawText, ev.scannedAt]);
  run('DELETE FROM scanner_events WHERE id NOT IN (SELECT id FROM scanner_events ORDER BY scanned_at DESC LIMIT 200)');
  await persist();
  return ev;
}

async function getLatestScannerEvent() {
  const r = execOne('SELECT id, raw_text, scanned_at FROM scanner_events ORDER BY scanned_at DESC LIMIT 1');
  return r ? { id: r[0], rawText: r[1], scannedAt: r[2] } : null;
}

async function deleteScannerEventById(id) {
  if (!id) {
    return false;
  }

  run('DELETE FROM scanner_events WHERE id = ?', [id]);
  await persist();
  return true;
}

// --- test_records ---

function rowToRecord(r) {
  try { var samples = JSON.parse(r[21]||'[]'); } catch { samples = []; }
  samples = Array.isArray(samples)
    ? samples.map((sample) => ({
        ...sample,
        leak: normalizeLegacyLeakValue(sample.leak),
        pressureUnit: normalizeUnitLabel(sample.pressureUnit),
        leakUnit: normalizeUnitLabel(sample.leakUnit)
      }))
    : [];
  const storedResultCode = String(r[17] || 'UNKNOWN').trim().toUpperCase();
  const derivedResultCode = decodeResultCode(r[19]);
  const storedErrorCode = r[18] || null;
  const derivedErrorCode = decodeErrorCode(r[19]);
  const resultCode = storedResultCode !== 'UNKNOWN' ? storedResultCode : derivedResultCode;
  const errorCode = storedErrorCode || derivedErrorCode;
  return { id: r[0], batchDate: r[1], dailySequence: r[2], sequenceCode: r[3],
    startedAt: r[4], finishedAt: r[5], startMode: r[6], qrCode: r[7],
    productId: r[8], productModel: r[9], ateqProgramNo: r[10], operatorName: r[11],
    testPressure: r[12], finalPressure: r[13], pressureUnit: normalizeUnitLabel(r[14]),
    finalLeak: normalizeFinalLeakValue(r[13], r[15]), leakUnit: normalizeUnitLabel(r[16]),
    resultCode,
    errorCode,
    errorText: deriveErrorText(r[19], errorCode, resultCode),
    rawStatusWord: r[19], sampleCount: r[20], samples, updatedAt: r[22] };
}

async function saveTestRecord(record) {
  const now = new Date().toISOString();
  const batchDate = record.batchDate || todayDateText();
  const r = execOne('SELECT COUNT(*) as cnt FROM test_records WHERE batch_date = ? AND UPPER(product_model) = ?', [batchDate, normalizeKey(record.productModel)]);
  const dailySequence = (r ? r[0] : 0) + 1;
  const sequenceCode = String(dailySequence).padStart(4, '0');
  const id = record.id || `test-${Date.now()}`;
  const normalizedSamples = Array.isArray(record.samples)
    ? record.samples.map((sample) => ({
        ...sample,
        leak: normalizeLegacyLeakValue(sample.leak),
        pressureUnit: normalizeUnitLabel(sample.pressureUnit),
        leakUnit: normalizeUnitLabel(sample.leakUnit)
      }))
    : [];
  const samplesJson = JSON.stringify(normalizedSamples);
  const pressureUnit = normalizeUnitLabel(record.pressureUnit);
  const leakUnit = normalizeUnitLabel(record.leakUnit);
  const finalPressure = record.finalPressure != null ? Number(record.finalPressure) : null;
  const finalLeak = record.finalLeak != null ? normalizeFinalLeakValue(finalPressure, record.finalLeak) : null;
  const normalizedResultCode = String(record.resultCode || '').trim().toUpperCase();
  const resultCode = normalizedResultCode && normalizedResultCode !== 'UNKNOWN'
    ? normalizedResultCode
    : decodeResultCode(record.rawStatusWord);
  const errorCode = record.errorCode || decodeErrorCode(record.rawStatusWord);

  run(`INSERT INTO test_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, batchDate, dailySequence, sequenceCode,
    record.startedAt||now, record.finishedAt||now,
    record.startMode||'', record.qrCode||'', record.productId||'',
    record.productModel||'', record.ateqProgramNo||0, record.operatorName||'',
    record.testPressure!=null?record.testPressure:null,
    finalPressure, pressureUnit,
    finalLeak, leakUnit,
    resultCode, errorCode,
    record.rawStatusWord||null, record.sampleCount||0, samplesJson, now]);
  await persist();

  const saved = execOne('SELECT * FROM test_records WHERE id = ?', [id]);
  return rowToRecord(saved);
}

async function listTestRecords() {
  const rows = execAll('SELECT * FROM test_records').map(rowToRecord);
  // Sort newest first
  rows.sort((a, b) => {
    const ta = Date.parse(a.startedAt) || 0;
    const tb = Date.parse(b.startedAt) || 0;
    return tb - ta;
  });
  return rows;
}

async function queryTestRecords(filters) {
  const { startTime, endTime, productModel, resultCode, qrCode, failureReason, qrExact, disablePaging, page, pageSize } = filters;
  const conds = [], params = [];

  if (startTime) { conds.push('started_at >= ?'); params.push(startTime); }
  if (endTime) { conds.push('started_at <= ?'); params.push(endTime); }
  if (productModel) { conds.push('UPPER(product_model) = ?'); params.push(normalizeKey(productModel)); }
  if (resultCode && normalizeKey(resultCode)!=='ALL') { conds.push('UPPER(result_code) = ?'); params.push(normalizeKey(resultCode)); }
  if (qrCode) {
    if (qrExact) { conds.push('qr_code = ?'); params.push(String(qrCode).trim()); }
    else { conds.push('UPPER(qr_code) LIKE ?'); params.push('%'+normalizeKey(qrCode)+'%'); }
  }

  const safePage = Math.max(1, Number(page||1));
  const safePageSize = Math.max(1, Math.min(200, Number(pageSize||50)));
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  let rows = execAll(`SELECT * FROM test_records ${where}`, params).map(rowToRecord);

  if (failureReason) {
    const normalizedFailureReason = normalizeKey(failureReason);
    rows = rows.filter((record) => {
      const candidate = normalizeKey(record.errorText || record.errorCode || '');
      return candidate.includes(normalizedFailureReason);
    });
  }

  rows.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
  const total = rows.length;

  if (disablePaging) {
    return { total, page: 1, pageSize: total, records: rows };
  }

  const offset = (safePage-1) * safePageSize;
  const paged = rows.slice(offset, offset + safePageSize);
  return { total, page: safePage, pageSize: safePageSize, records: paged };
}

async function getAppMeta(key) {
  const row = execOne('SELECT value FROM app_meta WHERE key = ?', [key]);
  return row ? row[0] : null;
}

async function setAppMeta(key, value) {
  const now = new Date().toISOString();
  run('INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES (?,?,?)', [key, value, now]);
  await persist();
  return value;
}

module.exports = {
  initDatabase,
  getCommConfig, saveCommConfig,
  listOperators, saveOperators, getOperatorByName,
  listProductProfiles, saveProductProfiles, getProductProfileByModel, getProductProfileByProgramNo, matchProductProfileByQr,
  saveScannerEvent, getLatestScannerEvent, deleteScannerEventById,
  saveTestRecord, listTestRecords, queryTestRecords,
  getAppMeta, setAppMeta
};

