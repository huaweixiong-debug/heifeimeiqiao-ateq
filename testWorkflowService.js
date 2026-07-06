const {
  getCommConfig,
  getOperatorByName,
  getProductProfileByModel,
  getProductProfileByProgramNo,
  matchProductProfileByQr,
  saveTestRecord,
  deleteScannerEventById
} = require('./db');
const { modbusService, ModbusError } = require('./modbusService');
const { scannerService } = require('./scannerService');

const WORKFLOW_STATES = Object.freeze({
  IDLE: 'idle',
  WAITING_SCAN: 'waiting_scan',
  MATCHED: 'matched',
  SELECTING_PROGRAM: 'selecting_program',
  RESETTING: 'resetting',
  STARTING: 'starting',
  TESTING: 'testing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted'
});

const ARMED_CONTEXT_STALE_MS = 8000;
const DEFAULT_MONITOR_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_MONITOR_SAMPLE_COUNT = 10000;
const ACTIVE_SAMPLE_WINDOW_COUNT = 10000;
const SAVED_SAMPLE_WINDOW_COUNT = 10000;
const ATEQ_IDLE_STEP_CODES = new Set([0, 65535]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAteqActiveStep(stepCode) {
  const numericStepCode = Number(stepCode);
  return Number.isFinite(numericStepCode) && numericStepCode >= 1 && numericStepCode <= 100;
}

class TestWorkflowError extends Error {
  constructor(message, statusCode = 400, cause = null) {
    super(message);
    this.name = 'TestWorkflowError';
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

class TestWorkflowService {
  constructor() {
    this.activeRun = null;
    this.pendingContext = null;
    this.selectedContext = null;
    this.lastObservedStepCode = null;
    this.lastRejectedObservedRunAt = 0;
    this.commandInFlight = false;
    this.observeInFlight = false;
  }

  createPendingContext(context, armed = false) {
    return {
      ...context,
      armed: Boolean(armed),
      armedAt: armed ? new Date().toISOString() : null,
      syncedAt: new Date().toISOString()
    };
  }

  createSelectedContext(context) {
    return this.createPendingContext({
      productProfile: context.productProfile,
      operator: context.operator || null,
      qrCode: '',
      recordQrCode: '',
      scannerEventId: null,
      startMode: 'manual'
    }, false);
  }

  hasArmedPendingContext() {
    return Boolean(this.pendingContext && this.pendingContext.armed);
  }

  getArmedContextAgeMs() {
    if (!this.hasArmedPendingContext()) {
      return 0;
    }

    const armedAtMs = Date.parse(this.pendingContext.armedAt);
    if (!Number.isFinite(armedAtMs)) {
      return Number.MAX_SAFE_INTEGER;
    }

    return Date.now() - armedAtMs;
  }

  async releaseStaleArmedContextIfSafe() {
    if (!this.hasArmedPendingContext() || this.commandInFlight) {
      return false;
    }

    if (this.getArmedContextAgeMs() < ARMED_CONTEXT_STALE_MS) {
      return false;
    }

    try {
      const status = await modbusService.readRealtimeStatus();
      if (!status || !ATEQ_IDLE_STEP_CODES.has(Number(status.stepCode))) {
        return false;
      }
    } catch (error) {
      if (!(error instanceof ModbusError)) {
        console.error('[workflow] failed to verify stale armed context', error);
      }
    }

    console.log('[workflow] released stale armed context while waiting for step 1');
    this.pendingContext = null;
    return true;
  }

  getActiveState() {
    if (this.activeRun) {
      return JSON.parse(JSON.stringify(this.activeRun.state));
    }

    if (this.pendingContext) {
      return {
        running: false,
        stage: this.pendingContext.armed ? 'armed' : 'ready',
        message: this.pendingContext.armed ? 'Waiting for ATEQ step 1' : 'Ready to start',
        startedAt: null,
        finishedAt: null,
        startMode: this.pendingContext.startMode,
        qrCode: this.pendingContext.qrCode,
        scannerEventId: this.pendingContext.scannerEventId,
        operatorName: this.pendingContext.operator ? this.pendingContext.operator.name : '',
        matchedProduct: this.toMatchedProduct(this.pendingContext.productProfile),
        latestTelemetry: null,
        samples: [],
        resultCode: 'UNKNOWN',
        errorCode: null,
        savedRecord: null
      };
    }

    if (this.selectedContext) {
      return {
        running: false,
        stage: 'ready',
        message: 'Ready to start',
        startedAt: null,
        finishedAt: null,
        startMode: this.selectedContext.startMode,
        qrCode: '',
        scannerEventId: null,
        operatorName: this.selectedContext.operator ? this.selectedContext.operator.name : '',
        matchedProduct: this.toMatchedProduct(this.selectedContext.productProfile),
        latestTelemetry: null,
        samples: [],
        resultCode: 'UNKNOWN',
        errorCode: null,
        savedRecord: null
      };
    }

    return {
      running: false,
      stage: 'idle',
      message: 'No active test'
    };
  }

  shouldObserveTelemetry() {
    return !this.commandInFlight && !(this.activeRun && this.activeRun.state.running);
  }

  async maybeAutoStartFromScan(qrCode) {
    if ((this.activeRun && this.activeRun.state.running) || this.commandInFlight || this.hasArmedPendingContext()) {
      return null;
    }

    const scanBinding = await this.resolveScanBinding(typeof qrCode === 'string' ? { qrCode } : qrCode);
    if (!scanBinding.qrCode) {
      return null;
    }

    const pendingProduct = this.pendingContext && this.pendingContext.productProfile
      ? this.pendingContext.productProfile
      : null;
    const selectedProduct = this.selectedContext && this.selectedContext.productProfile
      ? this.selectedContext.productProfile
      : null;
    const productProfile = pendingProduct || selectedProduct || await matchProductProfileByQr(scanBinding.qrCode);
    if (!productProfile) {
      return null;
    }

    if (productProfile.scanAutoStartEnabled !== true) {
      return null;
    }

    if (productProfile.scanMatchEnabled === true) {
      try {
        this.assertManualProductMatchesScan(productProfile, scanBinding.qrCode);
      } catch (error) {
        return null;
      }
    }

    try {
      return await this.start({
        qrCode: scanBinding.qrCode,
        scannerEventId: scanBinding.scannerEventId,
        productModel: productProfile.productModel,
        operatorName: this.selectedContext && this.selectedContext.operator ? this.selectedContext.operator.name : undefined,
        startMode: 'scan'
      });
    } catch (error) {
      console.error('[workflow] auto start failed', error);
      return null;
    }
  }

  async syncContext(payload) {
    if (this.activeRun && this.activeRun.state.running) {
      throw new TestWorkflowError('Cannot change context during active test', 409);
    }
    await this.releaseStaleArmedContextIfSafe();
    if (this.hasArmedPendingContext() || this.commandInFlight) {
      throw new TestWorkflowError('Cannot change context while waiting for step 1', 409);
    }

    const context = await this.buildContext(payload, false);
    this.selectedContext = this.createSelectedContext(context);
    this.pendingContext = this.createPendingContext(context, false);
    let currentProgram = null;

    try {
      await modbusService.selectProgram(context.productProfile.ateqProgramNo);

      try {
        const status = await modbusService.readRealtimeStatus();
        currentProgram = Number.isInteger(Number(status.currentProgram))
          ? Number(status.currentProgram)
          : null;
      } catch (statusError) {
        currentProgram = Number(context.productProfile.ateqProgramNo);
      }
    } catch (error) {
      if (error instanceof ModbusError) {
        throw error;
      }
      throw new TestWorkflowError('ATEQ program select failed during context sync', 503, error);
    }

    return {
      success: true,
      message: 'Test context synced and program selected',
      selectedProgram: Number(context.productProfile.ateqProgramNo),
      currentProgram,
      context: this.getActiveState()
    };
  }

  async start(payload) {
    if (this.activeRun && this.activeRun.state.running) {
      throw new TestWorkflowError('A test is already running', 409);
    }
    await this.releaseStaleArmedContextIfSafe();
    if (this.commandInFlight || this.hasArmedPendingContext()) {
      throw new TestWorkflowError('Start command already sent, waiting for step 1', 409);
    }

    let context;
    try {
      context = await this.buildContext({
        ...payload,
        enforceScanConfirm: true,
        enforceScanKeywordMatch: true
      }, true);
    } catch (error) {
      if (error instanceof TestWorkflowError && error.message.includes('QR code does not contain the keyword')) {
        try {
          await modbusService.resetDevice();
        } catch (resetError) {
          console.error('[workflow] reset after scan mismatch failed', resetError);
        }
      }
      throw error;
    }
    this.pendingContext = this.createPendingContext(context, true);
    this.selectedContext = this.createSelectedContext(context);
    this.activeRun = null;

    this.commandInFlight = true;
    try {
      if (!payload.skipProgramSelect) {
        await modbusService.selectProgram(context.productProfile.ateqProgramNo);
      }
      await modbusService.startTest();
    } catch (error) {
      this.pendingContext = this.createPendingContext(context, false);
      if (error instanceof ModbusError) {
        throw error;
      }
      throw new TestWorkflowError('ATEQ start command failed', 503, error);
    } finally {
      this.commandInFlight = false;
    }

    return {
      success: true,
      message: 'Start command sent, waiting for step 1',
      resultCode: 'UNKNOWN',
      errorCode: null
    };
  }

  async observeTelemetry(telemetry) {
    const previousStepCode = this.lastObservedStepCode;
    this.lastObservedStepCode = telemetry ? telemetry.stepCode : null;

    if (!telemetry || !this.shouldObserveTelemetry() || this.observeInFlight) {
      return null;
    }

    const stepCode = Number(telemetry.stepCode);
    const enteredStep1 = stepCode === 1 && Number(previousStepCode) !== 1;
    const recoveredActiveStep = !enteredStep1 && !this.activeRun && isAteqActiveStep(stepCode);
    if (!enteredStep1 && !recoveredActiveStep) {
      return null;
    }

    this.observeInFlight = true;
    try {
      let context = null;
      try {
        context = await this.resolveObservedContext(telemetry);
      } catch (error) {
        if (error instanceof TestWorkflowError && error.statusCode === 409) {
          await this.stopRejectedObservedRun(telemetry, error.message);
          return null;
        }

        console.error('[workflow] failed to resolve observed context', error);
        return null;
      }

      if (!context) {
        console.log(`[workflow] active step ${stepCode} detected without context, program=${telemetry.currentProgram}`);
        return null;
      }

      if (recoveredActiveStep) {
        console.log(`[workflow] recovered active test at step ${stepCode}`);
      }

      return this.beginObservedRun(context, telemetry);
    } finally {
      this.observeInFlight = false;
    }
  }

  async stopRejectedObservedRun(telemetry, reason) {
    const now = Date.now();
    if (now - this.lastRejectedObservedRunAt < 2000) {
      return;
    }

    this.lastRejectedObservedRunAt = now;
    console.log(`[workflow] stopping physical start: ${reason}, program=${telemetry.currentProgram}, step=${telemetry.stepCode}`);
    try {
      await modbusService.resetDevice();
    } catch (error) {
      console.error('[workflow] failed to stop rejected physical start', error);
    }
  }

  async beginObservedRun(context, initialTelemetry) {
    if (this.activeRun && this.activeRun.state.running) {
      return null;
    }

    const startedAt = new Date().toISOString();
    this.pendingContext = null;
    this.activeRun = {
      cancelRequested: false,
      state: {
        running: true,
        stage: 'monitoring',
        message: 'Monitoring stepcode and telemetry',
        startedAt,
        finishedAt: null,
        startMode: context.startMode,
        qrCode: context.recordQrCode || context.qrCode,
        scannerEventId: context.scannerEventId,
        operatorName: context.operator ? context.operator.name : '',
        matchedProduct: this.toMatchedProduct(context.productProfile),
        latestTelemetry: null,
        samples: [],
        resultCode: 'UNKNOWN',
        errorCode: null,
        savedRecord: null
      }
    };

    this.monitorRun(
      context.productProfile,
      context.operator,
      context.qrCode,
      context.recordQrCode,
      context.scannerEventId,
      context.startMode,
      initialTelemetry
    ).catch((error) => {
      console.error('[workflow] background monitor failed', error);
    });

    return {
      success: true,
      message: 'Test monitoring started'
    };
  }

  async monitorRun(productProfile, operator, qrCode, recordQrCode, scannerEventId, startMode, initialTelemetry) {
    const state = this.activeRun.state;
    const samples = [];
    const step4Samples = [];
    let lastTelemetry = null;
    let testStarted = false;
    let testPressure = null;
    let finalPressure = null;
    let finalLeak = null;
    let finalPressureUnit = null;
    let finalLeakUnit = null;
    let finalResultCode = 'UNKNOWN';
    let finalErrorCode = null;
    let rawStatusWord = null;
    let previousStepCode = null;
    const config = await getCommConfig('ateq');
    const pollIntervalMs = Math.max(50, Number(config && config.pollIntervalMs ? config.pollIntervalMs : 100));
    const startedAtMs = Date.now();
    const timeoutMs = DEFAULT_MONITOR_TIMEOUT_MS;

    const applyTelemetry = (telemetry, sampledAt, elapsedMs) => {
      const sample = {
        sampledAt,
        elapsedMs,
        stepCode: telemetry.stepCode,
        pressure: telemetry.pressure,
        pressureUnit: telemetry.pressureUnit,
        leak: telemetry.leak,
        leakUnit: telemetry.leakUnit,
        resultCode: telemetry.resultCode,
        errorCode: telemetry.errorCode,
        statusWord: telemetry.statusWord
      };

      samples.push(sample);
      if (samples.length > MAX_MONITOR_SAMPLE_COUNT) {
        samples.shift();
      }

      state.samples = samples.slice(-ACTIVE_SAMPLE_WINDOW_COUNT);
      state.latestTelemetry = sample;
      state.currentStep = telemetry.stepCode;
      state.message = `Monitoring step ${telemetry.stepCode}`;

      rawStatusWord = telemetry.statusWord;
      lastTelemetry = telemetry;

      if (telemetry.stepCode >= 1 && telemetry.stepCode <= 100) {
        testStarted = true;
      }

      if (telemetry.stepCode === 3) {
        testPressure = telemetry.pressure;
      }

      if (telemetry.stepCode === 4) {
        step4Samples.push(sample);
        while (step4Samples.length && sample.elapsedMs - step4Samples[0].elapsedMs > 1000) {
          step4Samples.shift();
        }
        finalPressureUnit = sample.pressureUnit || finalPressureUnit;
      }

      if (previousStepCode === 4 && telemetry.stepCode !== 4 && step4Samples.length) {
        finalPressure = step4Samples[step4Samples.length - 1].pressure;
        finalPressureUnit = step4Samples[step4Samples.length - 1].pressureUnit || finalPressureUnit;
      }

      if (testStarted && telemetry.stepCode === 65535) {
        finalLeak = telemetry.leak;
        finalLeakUnit = telemetry.leakUnit || finalLeakUnit;
        if (step4Samples.length) {
          finalPressure = step4Samples[step4Samples.length - 1].pressure;
          finalPressureUnit = step4Samples[step4Samples.length - 1].pressureUnit || finalPressureUnit;
        } else if (Number.isFinite(Number(telemetry.pressure))) {
          finalPressure = telemetry.pressure;
          finalPressureUnit = telemetry.pressureUnit || finalPressureUnit;
        }
        finalResultCode = telemetry.resultCode;
        finalErrorCode = telemetry.errorCode;
        previousStepCode = telemetry.stepCode;
        return true;
      }

      if (testStarted && telemetry.stepCode === 0 && previousStepCode !== null) {
        if (step4Samples.length) {
          finalPressure = step4Samples[step4Samples.length - 1].pressure;
          finalPressureUnit = step4Samples[step4Samples.length - 1].pressureUnit || finalPressureUnit;
        } else if (Number.isFinite(Number(telemetry.pressure))) {
          finalPressure = telemetry.pressure;
          finalPressureUnit = telemetry.pressureUnit || finalPressureUnit;
        }
        finalLeak = finalLeak !== null ? finalLeak : telemetry.leak;
        finalLeakUnit = finalLeakUnit || telemetry.leakUnit;
        finalResultCode = telemetry.resultCode;
        finalErrorCode = telemetry.errorCode || 'ATEQ_RETURNED_IDLE';
        previousStepCode = telemetry.stepCode;
        return true;
      }

      previousStepCode = telemetry.stepCode;
      return false;
    };

    try {
      if (initialTelemetry) {
        const initialSampledAt = new Date().toISOString();
        const completedOnInitialStep = applyTelemetry(initialTelemetry, initialSampledAt, 0);
        if (completedOnInitialStep) {
          state.message = 'Monitoring completed on initial step';
        }
      }

      while (Date.now() - startedAtMs < timeoutMs) {
        if (!this.activeRun || this.activeRun.cancelRequested) {
          throw new TestWorkflowError('Test aborted by reset', 409);
        }

        if (lastTelemetry && (lastTelemetry.stepCode === 65535 || lastTelemetry.stepCode === 0) && testStarted) {
          break;
        }

        await sleep(pollIntervalMs);
        if (!this.activeRun || this.activeRun.cancelRequested) {
          throw new TestWorkflowError('Test aborted by reset', 409);
        }
        const telemetry = await modbusService.readRealtimeStatus();
        const sampledAt = new Date().toISOString();
        const elapsedMs = Date.now() - startedAtMs;
        const completed = applyTelemetry(telemetry, sampledAt, elapsedMs);
        if (completed) {
          break;
        }
      }

      if (!testStarted) {
        throw new TestWorkflowError('ATEQ test did not reach step 1', 504);
      }

      if (!lastTelemetry) {
        throw new TestWorkflowError('ATEQ returned no telemetry', 504);
      }

      if (finalPressure === null && step4Samples.length) {
        finalPressure = step4Samples[step4Samples.length - 1].pressure;
        finalPressureUnit = step4Samples[step4Samples.length - 1].pressureUnit || finalPressureUnit;
      } else if (
        finalPressure === null &&
        lastTelemetry &&
        (lastTelemetry.stepCode === 65535 || lastTelemetry.stepCode === 0) &&
        Number.isFinite(Number(lastTelemetry.pressure))
      ) {
        finalPressure = lastTelemetry.pressure;
        finalPressureUnit = lastTelemetry.pressureUnit || finalPressureUnit;
      }

      if (finalLeak === null) {
        finalLeak = lastTelemetry.leak;
        finalLeakUnit = finalLeakUnit || lastTelemetry.leakUnit;
      }

      const savedRecord = await saveTestRecord({
        startedAt: state.startedAt,
        finishedAt: new Date().toISOString(),
        startMode,
        qrCode: recordQrCode,
        productId: productProfile.id,
        productModel: productProfile.productModel,
        ateqProgramNo: productProfile.ateqProgramNo,
        operatorName: operator ? operator.name : '',
        testPressure,
        finalPressure,
        pressureUnit: finalPressureUnit || lastTelemetry.pressureUnit,
        finalLeak,
        leakUnit: finalLeakUnit || lastTelemetry.leakUnit,
        resultCode: finalResultCode,
        errorCode: finalErrorCode,
        rawStatusWord,
        sampleCount: samples.length,
        samples: samples.slice(-SAVED_SAMPLE_WINDOW_COUNT)
      });

      state.running = false;
      state.stage = 'completed';
      state.message = 'Test completed';
      state.finishedAt = savedRecord.finishedAt;
      state.resultCode = savedRecord.resultCode;
      state.errorCode = savedRecord.errorCode;
      state.savedRecord = {
        id: savedRecord.id,
        sequenceCode: savedRecord.sequenceCode,
        qrCode: savedRecord.qrCode,
        productModel: savedRecord.productModel,
        resultCode: savedRecord.resultCode,
        errorCode: savedRecord.errorCode,
        errorText: savedRecord.errorText,
        finalPressure: savedRecord.finalPressure,
        pressureUnit: savedRecord.pressureUnit,
        finalLeak: savedRecord.finalLeak,
        leakUnit: savedRecord.leakUnit
      };

      if (qrCode || scannerEventId) {
        try {
          if (scannerEventId) {
            await deleteScannerEventById(scannerEventId);
          }
          scannerService.consumeCurrentScan({ scannerEventId, qrCode });
          state.qrCode = '';
          state.scannerEventId = null;
        } catch (clearError) {
          console.error('[workflow] failed to clear scanner result', clearError);
        }
      }
    } catch (error) {
      if (this.activeRun && this.activeRun.cancelRequested) {
        state.running = false;
        state.stage = 'aborted';
        state.message = 'ATEQ reset requested';
        state.finishedAt = new Date().toISOString();
        state.resultCode = 'UNKNOWN';
        state.errorCode = 'ATEQ_RESET_ABORT';
        state.savedRecord = null;
        return;
      }

      const message = error instanceof TestWorkflowError || error instanceof ModbusError
        ? error.message
        : 'Test workflow failed';
      const statusCode = error.statusCode || 503;

      state.running = false;
      state.stage = 'failed';
      state.message = message;
      state.finishedAt = new Date().toISOString();
      state.resultCode = 'UNKNOWN';
      state.errorCode = message;
      state.failureStatusCode = statusCode;
    } finally {
      setTimeout(() => {
        if (this.activeRun && !this.activeRun.state.running) {
          this.activeRun = null;
        }
      }, 15000);
    }
  }

  handleResetCommand() {
    this.pendingContext = null;

    if (!this.activeRun) {
      return;
    }

    if (this.activeRun.state.running) {
      this.activeRun.cancelRequested = true;
      return;
    }

    this.activeRun = null;
  }

  async buildContext(payload, allowQrResolution) {
    const productProfile = await this.resolveProduct(payload);
    const operator = await this.resolveOperator(payload.operatorName);
    const scanBinding = allowQrResolution ? await this.resolveScanBinding(payload) : { qrCode: '', scannerEventId: null };
    const scanConfirmEnabled = productProfile.scanConfirmEnabled !== false;
    const scanMatchEnabled = productProfile.scanMatchEnabled === true;
    const startMode = scanBinding.qrCode ? 'scan' : (payload.startMode === 'scan' ? 'scan' : 'manual');

    if (payload.productModel && payload.enforceScanConfirm && scanConfirmEnabled) {
      this.assertManualProductHasScan(productProfile, scanBinding.qrCode);
    }

    if (payload.productModel && payload.enforceScanKeywordMatch && scanMatchEnabled) {
      this.assertManualProductMatchesScan(productProfile, scanBinding.qrCode);
    }

    return {
      productProfile,
      operator,
      qrCode: scanBinding.qrCode,
      recordQrCode: scanBinding.qrCode,
      scannerEventId: scanBinding.scannerEventId,
      startMode
    };
  }

  async resolveObservedContext(telemetry) {
    let productProfile = null;
    let operator = this.pendingContext
      ? this.pendingContext.operator
      : (this.selectedContext ? this.selectedContext.operator : null);
    let startMode = this.pendingContext ? this.pendingContext.startMode : 'manual';

    if (
      this.pendingContext &&
      this.pendingContext.productProfile &&
      Number(this.pendingContext.productProfile.ateqProgramNo) === Number(telemetry.currentProgram)
    ) {
      productProfile = this.pendingContext.productProfile;
    }

    if (!productProfile) {
      productProfile = await getProductProfileByProgramNo(telemetry.currentProgram);
    }

    if (!productProfile && this.pendingContext) {
      productProfile = this.pendingContext.productProfile;
    }

    if (!productProfile) {
      return null;
    }

    const scanBinding = await this.resolveScanBinding({});
    const requireScanRecord = productProfile.scanConfirmEnabled !== false;
    const requireScanMatch = productProfile.scanMatchEnabled === true;

    if (requireScanRecord && !scanBinding.qrCode) {
      throw new TestWorkflowError(`scan record is required for ${productProfile.productModel}`, 409);
    }

    if (requireScanMatch) {
      try {
        this.assertManualProductMatchesScan(productProfile, scanBinding.qrCode);
      } catch (error) {
        throw new TestWorkflowError(error.message, 409, error);
      }
    }

    if (scanBinding.qrCode) {
      startMode = 'scan';
    }

    return {
      productProfile,
      operator,
      qrCode: scanBinding.qrCode,
      recordQrCode: scanBinding.qrCode,
      scannerEventId: scanBinding.scannerEventId,
      startMode
    };
  }

  toMatchedProduct(productProfile) {
    if (!productProfile) {
      return null;
    }

    return {
      id: productProfile.id,
      productModel: productProfile.productModel,
      ateqProgramNo: productProfile.ateqProgramNo,
      qrKeyword: productProfile.qrKeyword
    };
  }

  assertManualProductMatchesScan(productProfile, qrCode) {
    if (!productProfile) {
      return;
    }

    const qrKeyword = String(productProfile.qrKeyword || '').trim();
    if (!qrKeyword) {
      return;
    }

    const scanText = String(qrCode || '').trim();
    if (!scanText || !scanText.toUpperCase().includes(qrKeyword.toUpperCase())) {
      throw new TestWorkflowError(`QR code does not contain the keyword for ${productProfile.productModel}: ${qrKeyword}`, 400);
    }
  }

  assertManualProductHasScan(productProfile, qrCode) {
    const scanText = String(qrCode || '').trim();
    if (!scanText) {
      throw new TestWorkflowError(`Scan record is required for ${productProfile.productModel}`, 400);
    }
  }

  async resolveProduct(payload) {
    if (payload.productModel) {
      const productProfile = await getProductProfileByModel(payload.productModel);
      if (!productProfile) {
        throw new TestWorkflowError(`Product model not found: ${payload.productModel}`, 404);
      }
      if (productProfile.isActive === false) {
        throw new TestWorkflowError(`Product model is inactive: ${payload.productModel}`, 400);
      }
      return productProfile;
    }

    if (payload.qrCode) {
      const productProfile = await matchProductProfileByQr(payload.qrCode);
      if (!productProfile) {
        throw new TestWorkflowError('No product profile matched the QR code', 404);
      }
      return productProfile;
    }

    throw new TestWorkflowError('productModel or qrCode is required', 400);
  }

  async resolveOperator(operatorName) {
    if (!operatorName) {
      return null;
    }

    const operator = await getOperatorByName(operatorName);
    if (!operator) {
      throw new TestWorkflowError(`Operator not found: ${operatorName}`, 404);
    }

    if (operator.isActive === false) {
      throw new TestWorkflowError(`Operator is inactive: ${operatorName}`, 400);
    }

    return operator;
  }

  async resolveScanBinding(payload) {
    const scannerEventId = payload && payload.scannerEventId ? String(payload.scannerEventId).trim() : null;
    const explicitQrCode = payload && payload.qrCode ? String(payload.qrCode).trim() : '';
    const latestVisibleScan = scannerService.getLatestVisibleScan();

    if (explicitQrCode) {
      if (scannerEventId) {
        return { qrCode: explicitQrCode, scannerEventId };
      }

      if (latestVisibleScan && latestVisibleScan.rawText === explicitQrCode) {
        return { qrCode: explicitQrCode, scannerEventId: latestVisibleScan.id || null };
      }

      return { qrCode: explicitQrCode, scannerEventId: null };
    }

    if (!latestVisibleScan) {
      return { qrCode: '', scannerEventId: null };
    }

    return {
      qrCode: String(latestVisibleScan.rawText || '').trim(),
      scannerEventId: latestVisibleScan.id || null
    };
  }
}

module.exports = {
  TestWorkflowError,
  WORKFLOW_STATES,
  MONITOR_SETTINGS: {
    defaultMonitorTimeoutMs: DEFAULT_MONITOR_TIMEOUT_MS,
    maxMonitorSampleCount: MAX_MONITOR_SAMPLE_COUNT,
    activeSampleWindowCount: ACTIVE_SAMPLE_WINDOW_COUNT,
    savedSampleWindowCount: SAVED_SAMPLE_WINDOW_COUNT
  },
  testWorkflowService: new TestWorkflowService()
};
