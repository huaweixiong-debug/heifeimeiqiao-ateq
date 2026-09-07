const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { body, query, validationResult } = require('express-validator');
const { SerialPort } = require('serialport');

const {
  initDatabase,
  getCommConfig,
  saveCommConfig,
  listOperators,
  saveOperators,
  listProductProfiles,
  saveProductProfiles,
  saveScannerEvent,
  listTestRecords,
  queryTestRecords
} = require('./db');
const { modbusService, ModbusError } = require('./modbusService');
const { scannerService, ScannerError } = require('./scannerService');
const { testWorkflowService, TestWorkflowError, MONITOR_SETTINGS } = require('./testWorkflowService');
const license = require('./license');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OBSERVER_POLL_MS = 500;
const STATUS_STALE_FALLBACK_MS = 5000;
let observerBusy = false;

async function handleScannerInput(scan) {
  try {
    const status = await modbusService.readRealtimeStatus();
    if (status.stepCode !== 65535) {
      console.log(`[scanner] ignored scan at step ${status.stepCode}`);
      return;
    }

    const savedScan = await saveScannerEvent(scan.rawText);
    scannerService.syncLatestScan(savedScan);
    await testWorkflowService.maybeAutoStartFromScan(savedScan);
  } catch (error) {
    if (error instanceof ModbusError) {
      console.error('[scanner] rejected scan because ATEQ status is unavailable', error.message);
      return;
    }

    console.error('[scanner] failed to persist or auto-start', error);
  }
}

async function observeAteqState() {
  if (observerBusy || !testWorkflowService.shouldObserveTelemetry()) {
    return;
  }

  observerBusy = true;
  try {
    const status = await modbusService.readRealtimeStatus();
    await testWorkflowService.observeTelemetry(status);
  } catch (error) {
    if (!(error instanceof ModbusError)) {
      console.error('[observer] failed to inspect ATEQ state', error);
    }
  } finally {
    observerBusy = false;
  }
}

function buildValidationErrorResponse(result) {
  return {
    success: false,
    message: 'Validation failed',
    errors: result.array().map((item) => ({
      field: item.path,
      message: item.msg
    }))
  };
}

function configValidators(deviceType) {
  const validators = [
    body('comPort').isString().trim().notEmpty().withMessage('COM port is required'),
    body('baudrate').isInt({ min: 1 }).withMessage('baudrate must be a positive integer'),
    body('dataBits').isInt({ min: 5, max: 8 }).withMessage('dataBits must be between 5 and 8'),
    body('parity').isIn(['none', 'even', 'mark', 'odd', 'space']).withMessage('parity is invalid'),
    body('stopBits').isFloat({ min: 1, max: 2 }).withMessage('stopBits must be 1 or 2'),
    body('timeoutMs').optional().isInt({ min: 100, max: 5000 }).withMessage('timeoutMs must be between 100 and 5000'),
    body('pollIntervalMs').optional().isInt({ min: 50, max: 2000 }).withMessage('pollIntervalMs must be between 50 and 2000'),
    body('dtr').optional().isBoolean().withMessage('dtr must be boolean'),
    body('rts').optional().isBoolean().withMessage('rts must be boolean'),
    body('enabled').isBoolean().withMessage('enabled must be boolean')
  ];

  if (deviceType === 'ateq') {
    validators.push(body('slaveId').isInt({ min: 1, max: 255 }).withMessage('slaveId must be between 1 and 255'));
  }

  return validators;
}

const productProfileValidators = [
  body('products').isArray().withMessage('products must be an array'),
  body('products.*.productModel').isString().trim().notEmpty().withMessage('productModel is required'),
  body('products.*.ateqProgramNo').isInt({ min: 1, max: 255 }).withMessage('ateqProgramNo must be between 1 and 255'),
  body('products.*.qrKeyword').isString().trim().notEmpty().withMessage('qrKeyword is required'),
  body('products.*.isActive').optional().isBoolean().withMessage('isActive must be boolean'),
  body('products.*.scanConfirmEnabled').optional().isBoolean().withMessage('scanConfirmEnabled must be boolean'),
  body('products.*.scanAutoStartEnabled').optional().isBoolean().withMessage('scanAutoStartEnabled must be boolean'),
  body('products.*.scanMatchEnabled').optional().isBoolean().withMessage('scanMatchEnabled must be boolean')
];

const operatorValidators = [
  body('operators').isArray().withMessage('operators must be an array'),
  body('operators.*.name').isString().trim().notEmpty().withMessage('operator name is required'),
  body('operators.*.isActive').optional().isBoolean().withMessage('isActive must be boolean')
];

const startValidators = [
  body('productModel').optional().isString().trim().notEmpty().withMessage('productModel cannot be empty'),
  body('operatorName').optional().isString().trim().notEmpty().withMessage('operatorName cannot be empty'),
  body('qrCode').optional().isString().trim().notEmpty().withMessage('qrCode cannot be empty'),
  body('skipProgramSelect').optional().isBoolean().withMessage('skipProgramSelect must be boolean'),
  body('startMode').optional().isIn(['manual', 'scan']).withMessage('startMode must be manual or scan')
];

const contextValidators = [
  body('productModel').isString().trim().notEmpty().withMessage('productModel is required'),
  body('operatorName').optional().isString().trim().notEmpty().withMessage('operatorName cannot be empty')
];

const testQueryValidators = [
  query('startTime').optional().isISO8601().withMessage('startTime must be ISO8601 datetime'),
  query('endTime')
    .optional()
    .isISO8601()
    .withMessage('endTime must be ISO8601 datetime')
    .custom((value, { req }) => {
      if (!req.query.startTime) {
        return true;
      }

      if (Date.parse(value) < Date.parse(req.query.startTime)) {
        throw new Error('endTime must be greater than or equal to startTime');
      }

      return true;
    }),
  query('productModel').optional().isString().trim().notEmpty().withMessage('productModel cannot be empty'),
  query('resultCode').optional().isIn(['OK', 'NG', 'UNKNOWN', 'ALL']).withMessage('resultCode is invalid'),
  query('qrCode').optional().isString().trim().notEmpty().withMessage('qrCode cannot be empty'),
  query('failureReason').optional().isString().trim().notEmpty().withMessage('failureReason cannot be empty'),
  query('qrExact').optional().isBoolean().withMessage('qrExact must be boolean'),
  query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
  query('pageSize').optional().isInt({ min: 1, max: 200 }).withMessage('pageSize must be between 1 and 200')
];

const programTimingValidators = [
  query('programNumber').isInt({ min: 1, max: 255 }).withMessage('programNumber must be between 1 and 255')
];

const scannerLineSignalValidators = [
  body('dtr').isBoolean().withMessage('dtr must be boolean'),
  body('rts').isBoolean().withMessage('rts must be boolean'),
  body('reconnect').optional().isBoolean().withMessage('reconnect must be boolean')
];

function normalizeConfig(payload, deviceType) {
  return {
    comPort: String(payload.comPort).toUpperCase(),
    baudrate: Number(payload.baudrate),
    dataBits: Number(payload.dataBits),
    parity: String(payload.parity).toLowerCase(),
    stopBits: Number(payload.stopBits),
    slaveId: deviceType === 'ateq' ? Number(payload.slaveId) : null,
    timeoutMs: Number(payload.timeoutMs || 5000),
    pollIntervalMs: Number(payload.pollIntervalMs || 100),
    dtr: normalizeBoolean(payload.dtr, true),
    rts: normalizeBoolean(payload.rts, true),
    enabled: Boolean(payload.enabled)
  };
}

function normalizeOperators(payload) {
  return payload.operators.map((operator, index) => ({
    id: operator.id || `operator-${index + 1}`,
    name: String(operator.name).trim(),
    isActive: operator.isActive !== false
  }));
}

function normalizeProductProfiles(payload) {
  return payload.products.map((productProfile, index) => {
    let scanConfirmEnabled = normalizeBoolean(productProfile.scanConfirmEnabled, true);
    let scanMatchEnabled = normalizeBoolean(productProfile.scanMatchEnabled, false);
    let scanAutoStartEnabled = normalizeBoolean(productProfile.scanAutoStartEnabled, false);

    if (scanAutoStartEnabled) {
      scanConfirmEnabled = true;
    }
    if (scanMatchEnabled) {
      scanConfirmEnabled = true;
    }

    return {
      id: productProfile.id || `product-${index + 1}`,
      productModel: String(productProfile.productModel).trim(),
      ateqProgramNo: Number(productProfile.ateqProgramNo),
      qrKeyword: String(productProfile.qrKeyword).trim(),
      isActive: productProfile.isActive !== false,
      fillTime: productProfile.fillTime != null ? Number(productProfile.fillTime) : null,
      stabTime: productProfile.stabTime != null ? Number(productProfile.stabTime) : null,
      testTime: productProfile.testTime != null ? Number(productProfile.testTime) : null,
      scanConfirmEnabled,
      scanMatchEnabled,
      scanAutoStartEnabled
    };
  });
}

function normalizeBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }

  return defaultValue;
}

function normalizeTestQuery(queryParams) {
  return {
    startTime: queryParams.startTime || null,
    endTime: queryParams.endTime || null,
    productModel: queryParams.productModel || null,
    resultCode: queryParams.resultCode || 'ALL',
    qrCode: queryParams.qrCode || null,
    failureReason: queryParams.failureReason || null,
    qrExact: normalizeBoolean(queryParams.qrExact, false),
    page: Number(queryParams.page || 1),
    pageSize: Number(queryParams.pageSize || 50)
  };
}

function escapeCsvValue(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildTestsCsv(records) {
  const columns = [
    ['sequenceCode', '序号'],
    ['startedAt', '测试时间'],
    ['qrCode', '二维码'],
    ['finalPressure', '测试压力'],
    ['pressureUnit', '压力单位'],
    ['finalLeak', '最终泄漏量'],
    ['leakUnit', '泄漏单位'],
    ['resultCode', '测试结果'],
    ['errorText', '失败原因'],
    ['productModel', '产品型号'],
    ['operatorName', '操作人员'],
    ['startMode', '启动方式'],
    ['ateqProgramNo', 'ATEQ程序号'],
    ['errorCode', '错误码']
  ];

  const header = columns.map(([, label]) => escapeCsvValue(label)).join(',');
  const rows = records.map((record) =>
    columns.map(([key]) => escapeCsvValue(record[key])).join(',')
  );

  return [header, ...rows].join('\r\n');
}

function assertUniqueBy(records, keySelector, label) {
  const seen = new Set();

  for (const record of records) {
    const key = String(keySelector(record) || '').trim().toUpperCase();
    if (seen.has(key)) {
      const error = new Error(`${label} contains duplicate values`);
      error.statusCode = 400;
      throw error;
    }

    seen.add(key);
  }
}

async function applyBootConfigurations() {
  const ateqConfig = await getCommConfig('ateq');
  const scannerConfig = await getCommConfig('scanner');

  if (ateqConfig) {
    try {
      await modbusService.configure(ateqConfig);
    } catch (error) {
      console.error('[boot] failed to apply ateq config', error);
    }
  }

  if (scannerConfig) {
    try {
      await scannerService.configure(scannerConfig, handleScannerInput);
    } catch (error) {
      console.error('[boot] failed to apply scanner config', error);
    }
  }
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "upgrade-insecure-requests": null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ================= license gate ================= */
// 受限模式（试用到期未激活）下仅放行：扫码读取 + 泄漏测试主流程。
// 记录/查询/导出、设置、通讯配置、调试页等正式版功能一律锁定。
const LICENSE_OPEN_PREFIXES = [
  '/api/health',
  '/api/license',
  '/api/scanner/latest',
  '/api/scanner/input',
  '/api/status',
  '/api/test/active',
  '/api/test/context',
  '/api/program-timings',
  '/api/start',
  '/api/reset',
];
const LICENSE_OPEN_GET_PREFIXES = [
  '/api/settings/products',
  '/api/settings/operators',
];

app.use('/api', async (request, response, next) => {
  try {
    const status = await license.getLicenseStatus();
    const lic = status.license || {};
    if (lic.mode === 'full' || lic.mode === 'trial') {
      return next();
    }
    // 到期未激活：受限模式
    // 注意：app.use('/api', ...) 会剥离 '/api' 前缀，request.path 相对挂载点，
    // 因此用 baseUrl + path 还原完整路径再判断。
    const pathName = String((request.baseUrl || '') + (request.path || ''));
    const method = request.method || 'GET';

    const isOpen =
      LICENSE_OPEN_PREFIXES.some((p) => pathName === p || pathName.startsWith(p + '/')) ||
      (method === 'GET' && LICENSE_OPEN_GET_PREFIXES.some((p) => pathName === p || pathName.startsWith(p + '/')));

    // 记录/今日统计接口返回空数据（前端弹窗锁定提示，避免报错刷屏）
    if (method === 'GET' && (pathName === '/api/tests/latest' || pathName === '/api/tests/query')) {
      return response.json({ success: true, records: [], total: 0, licenseRestricted: true });
    }

    if (isOpen) {
      return next();
    }

    return response.status(403).json({
      success: false,
      error: 'LICENSE_REQUIRED',
      message: '试用期已结束，正式版功能已锁定。请输入激活码恢复完整功能。',
    });
  } catch (error) {
    return next();
  }
});

app.get('/api/license', async (request, response) => {
  try {
    const status = await license.getLicenseStatus();
    return response.json(status);
  } catch (error) {
    return response.status(500).json({ success: false, message: '许可证状态读取失败' });
  }
});

app.post('/api/license/activate', async (request, response) => {
  try {
    const code = String((request.body && request.body.code) || '').trim();
    const result = await license.activate(code);
    if (!result.ok) {
      return response.status(400).json({ success: false, message: result.message });
    }
    const status = await license.getLicenseStatus();
    return response.json({ success: true, message: '激活成功，已恢复正式版全部功能。', license: status.license });
  } catch (error) {
    return response.status(500).json({ success: false, message: '激活失败，请稍后重试' });
  }
});


app.get('/api/health', (request, response) => {
  response.json({
    success: true,
    message: 'ATEQ backend alive',
    build: 'monitor-30min-samples-10000',
    monitor: MONITOR_SETTINGS
  });
});

app.get('/api/config/ateq', async (request, response, next) => {
  try {
    const config = await getCommConfig('ateq');
    response.json({ success: true, config });
  } catch (error) {
    next(error);
  }
});

app.post('/api/config/ateq', configValidators('ateq'), async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const config = normalizeConfig(request.body, 'ateq');
    const saved = await saveCommConfig('ateq', config);
    const state = await modbusService.configure(saved);
    response.json({ success: true, config: saved, state });
  } catch (error) {
    next(error);
  }
});

app.get('/api/config/scanner', async (request, response, next) => {
  try {
    const config = await getCommConfig('scanner');
    response.json({ success: true, config });
  } catch (error) {
    next(error);
  }
});

app.post('/api/config/scanner', configValidators('scanner'), async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const config = normalizeConfig(request.body, 'scanner');
    const saved = await saveCommConfig('scanner', config);
    const state = await scannerService.configure(saved, handleScannerInput);
    response.json({ success: true, config: saved, state });
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings/products', async (request, response, next) => {
  try {
    const products = await listProductProfiles();
    response.json({ success: true, products });
  } catch (error) {
    next(error);
  }
});

app.post('/api/settings/products', productProfileValidators, async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const products = normalizeProductProfiles(request.body);
    assertUniqueBy(products, (item) => item.productModel, 'productModel');
    assertUniqueBy(products, (item) => item.qrKeyword, 'qrKeyword');
    assertUniqueBy(products, (item) => item.ateqProgramNo, 'ateqProgramNo');

    const saved = await saveProductProfiles(products);
    response.json({ success: true, message: 'Product profiles saved', products: saved });
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings/operators', async (request, response, next) => {
  try {
    const operators = await listOperators();
    response.json({ success: true, operators });
  } catch (error) {
    next(error);
  }
});

app.post('/api/settings/operators', operatorValidators, async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const operators = normalizeOperators(request.body);
    assertUniqueBy(operators, (item) => item.name, 'operator name');

    const saved = await saveOperators(operators);
    response.json({ success: true, message: 'Operators saved', operators: saved });
  } catch (error) {
    next(error);
  }
});

app.get('/api/scanner/latest', async (request, response, next) => {
  try {
    response.json({
      success: true,
      connected: scannerService.isConnected(),
      latestScan: scannerService.getLatestVisibleScan()
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/scanner/debug', (request, response) => {
  response.json({
    success: true,
    ...scannerService.getDebugState()
  });
});

app.get('/api/system/serial-ports', async (request, response, next) => {
  try {
    const ports = await SerialPort.list();
    const normalizedPorts = ports
      .map((port) => ({
        path: port.path,
        friendlyName: port.friendlyName || null,
        manufacturer: port.manufacturer || null,
        serialNumber: port.serialNumber || null,
        pnpId: port.pnpId || null,
        vendorId: port.vendorId || null,
        productId: port.productId || null
      }))
      .sort((left, right) => String(left.path || '').localeCompare(String(right.path || '')));

    response.json({
      success: true,
      ports: normalizedPorts,
      detected: normalizedPorts.map((port) => port.path)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/scanner/debug/line-signals', scannerLineSignalValidators, async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const currentConfig = await getCommConfig('scanner');
    if (!currentConfig) {
      response.status(404).json({
        success: false,
        message: 'Scanner config not found'
      });
      return;
    }

    const nextConfig = {
      ...currentConfig,
      dtr: normalizeBoolean(request.body.dtr, true),
      rts: normalizeBoolean(request.body.rts, true)
    };

    const savedConfig = await saveCommConfig('scanner', nextConfig);
    const state = await scannerService.updateLineSignals({
      dtr: savedConfig.dtr,
      rts: savedConfig.rts,
      reconnect: normalizeBoolean(request.body.reconnect, true)
    });

    response.json({
      success: true,
      message: 'Scanner line signals updated',
      config: savedConfig,
      state
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/status', async (request, response) => {
  try {
    const status = await modbusService.readRealtimeStatus();
    response.json({
      connected: status.connected,
      enabled: status.enabled,
      running: status.stepCode >= 1 && status.stepCode !== 65535,
      currentJob: status.currentProgram,
      currentStep: status.stepCode,
      resultCode: status.resultCode,
      errorCode: status.errorCode,
      errorText: status.errorText,
      telemetry: {
        pressure: status.pressure,
        pressureUnit: status.pressureUnit,
        leak: status.leak,
        leakUnit: status.leakUnit,
        stepCode: status.stepCode,
        statusWord: status.statusWord
      }
    });
  } catch (error) {
    const cachedStatus = modbusService.getLastStatusSnapshot(STATUS_STALE_FALLBACK_MS);
    if (cachedStatus) {
      response.json({
        connected: true,
        enabled: cachedStatus.enabled,
        running: cachedStatus.stepCode >= 1 && cachedStatus.stepCode !== 65535,
        currentJob: cachedStatus.currentProgram,
        currentStep: cachedStatus.stepCode,
        resultCode: cachedStatus.resultCode,
        errorCode: cachedStatus.errorCode,
        errorText: cachedStatus.errorText,
        telemetry: {
          pressure: cachedStatus.pressure,
          pressureUnit: cachedStatus.pressureUnit,
          leak: cachedStatus.leak,
          leakUnit: cachedStatus.leakUnit,
          stepCode: cachedStatus.stepCode,
          statusWord: cachedStatus.statusWord
        },
        stale: true,
        staleAgeMs: cachedStatus.snapshotAgeMs
      });
      return;
    }

    response.status(503).json({
      connected: false,
      enabled: true,
      running: false,
      currentJob: null,
      currentStep: null,
      resultCode: 'UNKNOWN',
      errorCode: error.message,
      errorText: error && error.cause && error.cause.message
        ? error.cause.message
        : error.message
    });
  }
});

app.get('/api/program-timings', programTimingValidators, async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const timings = await modbusService.readProgramTimings(Number(request.query.programNumber));
    response.json({ success: true, timings });
  } catch (error) {
    next(error);
  }
});

app.get('/api/test/active', (request, response) => {
  response.json({
    success: true,
    activeTest: testWorkflowService.getActiveState()
  });
});

app.post('/api/test/context', contextValidators, async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const result = await testWorkflowService.syncContext({
      productModel: request.body.productModel,
      operatorName: request.body.operatorName,
      startMode: 'manual'
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/start', startValidators, async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const result = await testWorkflowService.start({
      productModel: request.body.productModel,
      operatorName: request.body.operatorName,
      qrCode: request.body.qrCode,
      skipProgramSelect: normalizeBoolean(request.body.skipProgramSelect, false),
      startMode: request.body.startMode || (request.body.qrCode ? 'scan' : 'manual')
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/reset', async (request, response, next) => {
  try {
    await modbusService.resetDevice();
    testWorkflowService.handleResetCommand();
    const status = await modbusService.readRealtimeStatus().catch(() => null);
    response.json({
      success: true,
      message: 'ATEQ reset command sent',
      resultCode: status ? status.resultCode : 'UNKNOWN',
      errorCode: null,
      activeTest: testWorkflowService.getActiveState()
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/tests/latest', async (request, response, next) => {
  try {
    const records = await listTestRecords();
    response.json({
      success: true,
      total: records.length,
      records: records.slice(0, 50)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/tests/query', testQueryValidators, async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const filters = normalizeTestQuery(request.query);
    const result = await queryTestRecords(filters);
    response.json({
      success: true,
      filters,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      records: result.records
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/tests/export.csv', testQueryValidators, async (request, response, next) => {
  try {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      response.status(400).json(buildValidationErrorResponse(errors));
      return;
    }

    const filters = normalizeTestQuery(request.query);
    const queryResult = await queryTestRecords({
      ...filters,
      disablePaging: true
    });
    const csv = buildTestsCsv(queryResult.records);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="ateq-tests-${timestamp}.csv"`);
    response.send(`\uFEFF${csv}`);
  } catch (error) {
    next(error);
  }
});

app.use((error, request, response, next) => {
  console.error('[server] request failed', error);

  if (error instanceof TestWorkflowError) {
    response.status(error.statusCode || 400).json({
      success: false,
      message: error.message,
      error: error.cause ? String(error.cause.message || error.cause) : null
    });
    return;
  }

  if (error instanceof ModbusError || error instanceof ScannerError) {
    response.status(503).json({
      success: false,
      message: error.message,
      error: error.cause ? String(error.cause.message || error.cause) : null
    });
    return;
  }

  response.status(error.statusCode || 500).json({
    success: false,
    message: error.message || 'Internal server error',
    error: error.cause ? String(error.cause.message || error.cause) : null
  });
});

async function startServer() {
  try {
    await initDatabase();
    await license.ensureInstalled();
    app.listen(PORT, () => {
      console.log(`[server] listening on port ${PORT}`);
    });

    setInterval(() => {
      observeAteqState().catch((error) => {
        console.error('[observer] loop failed', error);
      });
    }, OBSERVER_POLL_MS);

    applyBootConfigurations().catch((error) => {
      console.error('[server] boot configuration failed', error);
    });
  } catch (error) {
    console.error('[server] startup failed', error);
    process.exit(1);
  }
}

startServer();

