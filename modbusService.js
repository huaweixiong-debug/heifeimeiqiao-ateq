const ModbusRTU = require('modbus-serial');

const REGISTERS = {
  WRITE_PROGRAM: 0x0200,
  READ_PROGRAM: 0x0202,
  EDIT_PROGRAM: 0x3004,
  STEP_CODE: 0x0020,
  REALTIME_STATUS: 0x0030,
  REALTIME_COUNT: 13,
  RESET_COIL: 0x0000,
  START_COIL: 0x0001
};

const PROGRAM_TIMING_PARAMETER_IDS = {
  fillTime: 0x0001,
  stabTime: 0x0002,
  testTime: 0x0003,
  dumpTime: 0x0009
};

const UNIT_CODE_MAP = {
  0: 'cm3/s',
  1000: 'cm3/min',
  2000: 'cm3/h',
  3000: 'mm3/h',
  4000: 'Pa(Cal.)',
  5000: 'Pa/s(Cal.)',
  6000: 'Pa',
  7000: 'Pa(HR)',
  8000: 'Pa/s',
  9000: 'Pa/s(HR)',
  10000: 's',
  11000: 'Bar',
  12000: 'kPa',
  13000: 'PSI',
  14000: 'mBar',
  15000: 'MPa',
  16000: 'L',
  17000: 'Cal unit',
  18000: 'kPa/s',
  19000: 'mm',
  20000: 'MOhm',
  21000: 'Ohm',
  22000: 'kV',
  23000: 'A',
  24000: 'mA',
  25000: 'mOhm',
  26000: '%',
  27000: 'kW',
  28000: 'V',
  29000: 'dB',
  30000: 'L/h',
  31000: 'mH',
  32000: 'uF',
  33000: 'Cal',
  34000: 'Factory Cal',
  35000: 'kPa(Cal.)',
  36000: 'kPa/s(Cal.)',
  37000: 'rpm',
  38000: 'GOhm',
  39000: 'W',
  40000: 'deg',
  41000: 'No unit',
  42000: 'mBar/s',
  43000: 'Pa(D)',
  44000: 'Pa(LR)',
  45000: 'Pa/s(LR)',
  46000: 'in3/s',
  47000: 'in3/min',
  48000: 'in3/h',
  49000: 'ft3/h',
  50000: 'mL/s',
  51000: 'mL/min',
  52000: 'mL/h',
  53000: 'L/min',
  54000: 'm3/h',
  55000: 'mm3',
  56000: 'cm3',
  57000: 'us',
  58000: 'cm3/s',
  59000: 'cm3/min',
  60000: 'cm3/h',
  61000: 'mL',
  62000: 'L',
  63000: 'in3',
  64000: 'ft3',
  65000: 'g/s',
  66000: 'g/min',
  67000: 'g/h',
  68000: 'oz(US)/s',
  69000: 'oz(US)/min',
  70000: 'oz(US)/h',
  71000: 'oz(UK)/s',
  72000: 'oz(UK)/min',
  73000: 'oz(UK)/h',
  74000: 'gal(US)',
  75000: 'gal(UK)',
  76000: 'ft3/s',
  77000: 'ft3/min',
  78000: 'No unit'
};

const UNIT_LABEL_ALIAS_MAP = {
  'SECOND': 's',
  'CALIBRATED PA': 'Pa(Cal.)',
  'CALIBRATED PA/S': 'Pa/s(Cal.)',
  'CALIBRATED KILOPASCAL': 'kPa(Cal.)',
  'CALIBRATED KILOPASCAL/SECOND': 'kPa/s(Cal.)',
  'HIGH RESOLUTION PA': 'Pa(HR)',
  'HIGH RESOLUTION PA/S': 'Pa/s(HR)',
  'LOW RESOLUTION PA': 'Pa(LR)',
  'LOW RESOLUTION PA/S': 'Pa/s(LR)',
  'D MODE PA': 'Pa(D)',
  'PASCAL': 'Pa',
  'PASCAL/SECOND': 'Pa/s',
  'KILOPASCAL': 'kPa',
  'KILOPASCAL/SECOND': 'kPa/s',
  'MILLIBAR': 'mBar',
  'MBAR/SECOND': 'mBar/s',
  'MILLIBAR/SECOND': 'mBar/s',
  'MEGA PASCAL': 'MPa',
  'LITRE': 'L',
  'LITRE/HOUR': 'L/h',
  'LITRE/MIN': 'L/min',
  'LITRE/MINUTE': 'L/min',
  'MILLILITRE/SECOND': 'mL/s',
  'MILLILITRE/MIN': 'mL/min',
  'MILLILITRE/MINUTE': 'mL/min',
  'MILLILITRE/HOUR': 'mL/h',
  'MILLILITRE': 'mL',
  'METER3/HOUR': 'm3/h',
  'ROTATION/MIN': 'rpm',
  'DEGREES (IN DIPHASE SHIFT)': 'deg',
  'NO UNIT': 'No unit',
  'PA(CAL.)': 'Pa(Cal.)',
  'PA/S(CAL.)': 'Pa/s(Cal.)',
  'KPA(CAL.)': 'kPa(Cal.)',
  'KPA/S(CAL.)': 'kPa/s(Cal.)',
  'PA(HR)': 'Pa(HR)',
  'PA/S(HR)': 'Pa/s(HR)',
  'PA(LR)': 'Pa(LR)',
  'PA/S(LR)': 'Pa/s(LR)',
  'PA(D)': 'Pa(D)',
  'MM3/H': 'mm3/h',
  'MM3': 'mm3',
  'CM3': 'cm3',
  'CM3/S': 'cm3/s',
  'CM3/MIN': 'cm3/min',
  'CM3/H': 'cm3/h',
  'INCH3': 'in3',
  'INCH3/S': 'in3/s',
  'INCH3/MIN': 'in3/min',
  'INCH3/HOUR': 'in3/h',
  'FEET3': 'ft3',
  'FEET3/SECOND': 'ft3/s',
  'FEET3/MINUTE': 'ft3/min',
  'FEET3/HOUR': 'ft3/h',
  'GRAM/SECOND': 'g/s',
  'GRAM/MINUTE': 'g/min',
  'GRAM/HOUR': 'g/h',
  'OZ (US) /SECOND': 'oz(US)/s',
  'OZ (US) /MINUTE': 'oz(US)/min',
  'OZ (US) /HOUR': 'oz(US)/h',
  'OZ (UK) /SECOND': 'oz(UK)/s',
  'OZ (UK) /MINUTE': 'oz(UK)/min',
  'OZ (UK) /HOUR': 'oz(UK)/h',
  'US GALLON': 'gal(US)',
  'UK GALLON': 'gal(UK)',
  'MICROSECOND': 'us',
  'PA（CAL.）': 'Pa(Cal.)',
  'PA/S（CAL.）': 'Pa/s(Cal.)',
  'PA（HR）': 'Pa(HR)',
  'PA/S（HR）': 'Pa/s(HR)',
  'PA（LR）': 'Pa(LR)',
  'PA/S（LR）': 'Pa/s(LR)',
  'PA（D）': 'Pa(D)'
};

const ALARM_CODE_MAP = {
  0: 'No alarm',
  1: 'Pressure switched alarm (test pressure too high)',
  2: 'Pressure switch (test pressure too small)',
  3: 'Large leak on TEST (EEEE)',
  4: 'Large leak on REF (MMMM)',
  7: 'Sensor out of order (overrun)',
  8: 'ATR error',
  9: 'ATR drift',
  10: 'CAL error',
  11: 'Volume too small (sealed component)',
  12: 'Volume too large (sealed component)',
  14: 'Equalization valve switching error',
  43: 'Pressure too high',
  44: 'Pressure too low',
  45: 'Piezo sensor out of order',
  46: 'Dump error',
  47: 'CAL drift error',
  48: 'Calibration check error',
  49: 'Leak in calibration check too high',
  50: 'Leak in calibration check too low',
  51: 'Sealed component learning error'
};

const STATUS_WORD_FLAGS = {
  PASS_PART: 0x0001,
  FAIL_TEST_PART: 0x0002,
  FAIL_REFERENCE_PART: 0x0004,
  ALARM: 0x0008,
  PRESSURE_ERROR: 0x0010,
  CYCLE_END: 0x0020,
  KEY_PRESENT: 0x8000
};

const ERROR_CODE_TEXT_MAP = {
  ATEQ_PRESSURE_ERROR: '压力异常',
  ATEQ_ALARM: '仪器报警'
};

class ModbusError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ModbusError';
    this.cause = cause;
  }
}

function swap16(value) {
  return ((value & 0xff) << 8) | ((value >> 8) & 0xff);
}

function combineSwappedUnsigned32(lowWord, highWord) {
  const low = swap16(lowWord);
  const high = swap16(highWord);
  return ((high * 0x10000) + low) >>> 0;
}

function decodeSignedScaled32(lowWord, highWord) {
  let raw = combineSwappedUnsigned32(lowWord, highWord);
  if (raw >= 0x80000000) {
    raw -= 0x100000000;
  }
  return raw / 1000;
}

function decodeUnitCode(lowWord, highWord) {
  return combineSwappedUnsigned32(lowWord, highWord);
}

function decodeSwappedUnsigned32(lowWord, highWord) {
  return combineSwappedUnsigned32(lowWord, highWord);
}

function normalizeUnitLabel(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return UNIT_CODE_MAP[value] || `CODE_${value}`;
  }

  const text = String(value).trim();
  const codeMatch = /^CODE_(\d+)$/i.exec(text);
  if (codeMatch) {
    const unitCode = Number(codeMatch[1]);
    return UNIT_CODE_MAP[unitCode] || text;
  }

  if (/^\d+$/.test(text)) {
    const unitCode = Number(text);
    return UNIT_CODE_MAP[unitCode] || text;
  }

  return UNIT_LABEL_ALIAS_MAP[text.toUpperCase()] || text;
}

function describeAlarmCode(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const alarmCode = Number(value);
  if (!Number.isInteger(alarmCode)) {
    return null;
  }

  return ALARM_CODE_MAP[alarmCode] || null;
}

function decodeResultCode(statusWord) {
  const word = Number(statusWord);
  if (!Number.isFinite(word)) {
    return 'UNKNOWN';
  }

  if (word & (STATUS_WORD_FLAGS.FAIL_TEST_PART | STATUS_WORD_FLAGS.FAIL_REFERENCE_PART)) {
    return 'NG';
  }

  if (word & STATUS_WORD_FLAGS.PASS_PART) {
    return 'OK';
  }

  return 'UNKNOWN';
}

function decodeErrorCode(statusWord) {
  const word = Number(statusWord);
  if (!Number.isFinite(word)) {
    return null;
  }

  if (word & STATUS_WORD_FLAGS.PRESSURE_ERROR) {
    return 'ATEQ_PRESSURE_ERROR';
  }

  if (word & STATUS_WORD_FLAGS.ALARM) {
    return 'ATEQ_ALARM';
  }

  return null;
}

function describeErrorCode(errorCode) {
  if (!errorCode) {
    return null;
  }

  return ERROR_CODE_TEXT_MAP[String(errorCode).trim().toUpperCase()] || null;
}

function describeStatusWord(statusWord, resultCode) {
  const word = Number(statusWord);
  if (!Number.isFinite(word)) {
    return null;
  }

  const reasons = [];
  if (word & STATUS_WORD_FLAGS.FAIL_TEST_PART) {
    reasons.push('测试件判定NG');
  }
  if (word & STATUS_WORD_FLAGS.FAIL_REFERENCE_PART) {
    reasons.push('参考侧判定NG');
  }
  if (word & STATUS_WORD_FLAGS.PRESSURE_ERROR) {
    reasons.push('压力异常');
  }
  if (word & STATUS_WORD_FLAGS.ALARM) {
    reasons.push('仪器报警');
  }

  if (reasons.length) {
    return reasons.join('，');
  }

  const normalizedResultCode = String(resultCode || decodeResultCode(word)).trim().toUpperCase();
  if (normalizedResultCode === 'OK') {
    return '测试合格';
  }
  if (word & STATUS_WORD_FLAGS.CYCLE_END) {
    return '测试循环结束';
  }

  return null;
}

function deriveErrorText(statusWord, errorCode, resultCode) {
  return describeStatusWord(statusWord, resultCode) || describeErrorCode(errorCode) || null;
}

function normalizeTimingValue(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 600000) {
    return null;
  }
  return Math.round(numericValue);
}

function hasCoreProgramTimings(timingsMs) {
  return ['fillTime', 'stabTime', 'testTime'].every((key) => Number.isFinite(timingsMs[key]));
}

function countProgramTimings(timingsMs) {
  return Object.values(timingsMs).filter((value) => Number.isFinite(value)).length;
}

function buildProgramTimingsPayload(programNumber, timingsMs, source) {
  const fillTimeMs = normalizeTimingValue(timingsMs.fillTime);
  const stabTimeMs = normalizeTimingValue(timingsMs.stabTime);
  const testTimeMs = normalizeTimingValue(timingsMs.testTime);
  const dumpTimeMs = normalizeTimingValue(timingsMs.dumpTime);
  const totalTimeMs = [fillTimeMs, stabTimeMs, testTimeMs]
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);

  return {
    programNumber,
    source,
    fillTimeMs,
    stabTimeMs,
    testTimeMs,
    dumpTimeMs,
    totalTimeMs,
    fillTimeSeconds: Number.isFinite(fillTimeMs) ? fillTimeMs / 1000 : null,
    stabTimeSeconds: Number.isFinite(stabTimeMs) ? stabTimeMs / 1000 : null,
    testTimeSeconds: Number.isFinite(testTimeMs) ? testTimeMs / 1000 : null,
    dumpTimeSeconds: Number.isFinite(dumpTimeMs) ? dumpTimeMs / 1000 : null,
    totalTimeSeconds: totalTimeMs > 0 ? totalTimeMs / 1000 : null
  };
}

function buildProgramTimingsDiagnostics(primaryPayload, fallbackPayload) {
  const diagnostics = {
    primarySource: primaryPayload?.source || null
  };

  if (fallbackPayload) {
    diagnostics.fallbackSource = fallbackPayload.source;
    diagnostics.fallbackTimings = {
      fillTimeMs: fallbackPayload.fillTimeMs,
      stabTimeMs: fallbackPayload.stabTimeMs,
      testTimeMs: fallbackPayload.testTimeMs,
      dumpTimeMs: fallbackPayload.dumpTimeMs
    };
  }

  return diagnostics;
}

class ModbusService {
  constructor() {
    this.client = new ModbusRTU();
    this.currentConfig = null;
    this.connected = false;
    this.queue = Promise.resolve();
    this.pendingStatusRead = null;
    this.lastStatusSnapshot = null;
    this.lastStatusSnapshotAt = 0;
  }

  getLastStatusSnapshot(maxAgeMs = 0) {
    if (!this.lastStatusSnapshot) {
      return null;
    }

    const ageMs = Date.now() - this.lastStatusSnapshotAt;
    if (maxAgeMs > 0 && ageMs > maxAgeMs) {
      return null;
    }

    return {
      ...this.lastStatusSnapshot,
      snapshotAgeMs: ageMs
    };
  }

  execute(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  async configure(config) {
    return this.execute(async () => {
      this.currentConfig = {
        comPort: config.comPort,
        baudrate: Number(config.baudrate),
        dataBits: Number(config.dataBits),
        parity: String(config.parity || 'none').toLowerCase(),
        stopBits: Number(config.stopBits),
        slaveId: Number(config.slaveId || 1),
        timeoutMs: Number(config.timeoutMs || 5000),
        enabled: Boolean(config.enabled)
      };

      if (!this.currentConfig.enabled) {
        await this.disconnect();
        return { connected: false, enabled: false };
      }

      await this.reconnect();
      return { connected: this.connected, enabled: true };
    });
  }

  async reconnect() {
    try {
      if (this.client.isOpen) {
        await this.client.close();
      }

      await this.client.connectRTUBuffered(this.currentConfig.comPort, {
        baudRate: this.currentConfig.baudrate,
        dataBits: this.currentConfig.dataBits,
        stopBits: this.currentConfig.stopBits,
        parity: this.currentConfig.parity
      });

      this.client.setID(this.currentConfig.slaveId);
      this.client.setTimeout(this.currentConfig.timeoutMs);
      this.connected = true;
      console.log(`[modbus] connected ${this.currentConfig.comPort}`);
    } catch (error) {
      this.connected = false;
      console.error('[modbus] connect failed', error);
      throw new ModbusError('ATEQ serial connect failed', error);
    }
  }

  async disconnect() {
    try {
      if (this.client.isOpen) {
        await this.client.close();
      }
    } catch (error) {
      console.error('[modbus] disconnect failed', error);
    }

    this.connected = false;
  }

  async ensureConnected() {
    if (!this.currentConfig || !this.currentConfig.enabled) {
      throw new ModbusError('ATEQ communication is not enabled');
    }

    if (!this.client.isOpen || !this.connected) {
      await this.reconnect();
    }
  }

  async selectProgram(programNumber) {
    return this.execute(async () => {
      try {
        await this.ensureConnected();

        if (!Number.isInteger(programNumber) || programNumber < 1 || programNumber > 255) {
          throw new ModbusError('ATEQ program number must be between 1 and 255');
        }

        if (
          this.lastStatusSnapshot &&
          this.lastStatusSnapshot.currentProgram === programNumber &&
          Date.now() - this.lastStatusSnapshotAt < 5000
        ) {
          return { success: true, programNumber, skipped: true };
        }

        const writeValue = swap16(programNumber - 1);
        await this.client.writeRegister(REGISTERS.WRITE_PROGRAM, writeValue);
        this.lastStatusSnapshotAt = 0;
        return { success: true, programNumber };
      } catch (error) {
        this.connected = false;
        if (error instanceof ModbusError) {
          throw error;
        }

        throw new ModbusError(`ATEQ program select failed: ${programNumber}`, error);
      }
    });
  }

  async readRealtimeStatus() {
    const now = Date.now();
    if (this.pendingStatusRead) {
      return this.pendingStatusRead;
    }

    if (this.lastStatusSnapshot && now - this.lastStatusSnapshotAt < 120) {
      return this.lastStatusSnapshot;
    }

    this.pendingStatusRead = this.execute(async () => {
      try {
        await this.ensureConnected();

        const response = await this.client.readHoldingRegisters(
          REGISTERS.REALTIME_STATUS,
          REGISTERS.REALTIME_COUNT
        );
        const registers = response.data;
        const statusWord = swap16(registers[3]);
        const stepCode = swap16(registers[4]);
        const pressureUnitCode = decodeUnitCode(registers[7], registers[8]);
        const leakUnitCode = decodeUnitCode(registers[11], registers[12]);

        const snapshot = {
          connected: true,
          enabled: true,
          stepCode,
          statusWord,
          currentProgram: swap16(registers[0]) + 1,
          pressure: decodeSignedScaled32(registers[5], registers[6]),
          pressureUnit: normalizeUnitLabel(pressureUnitCode),
          leak: decodeSignedScaled32(registers[9], registers[10]),
          leakUnit: normalizeUnitLabel(leakUnitCode),
          resultCode: decodeResultCode(statusWord),
          errorCode: decodeErrorCode(statusWord)
        };
        snapshot.errorText = deriveErrorText(snapshot.statusWord, snapshot.errorCode, snapshot.resultCode);

        this.lastStatusSnapshot = snapshot;
        this.lastStatusSnapshotAt = Date.now();
        return snapshot;
      } catch (error) {
        this.connected = false;
        if (error instanceof ModbusError) {
          throw error;
        }

        throw new ModbusError('ATEQ realtime status read failed', error);
      } finally {
        this.pendingStatusRead = null;
      }
    });

    return this.pendingStatusRead;
  }

  async readProgramTimings(programNumber) {
    return this.execute(async () => {
      try {
        await this.ensureConnected();

        if (!Number.isInteger(programNumber) || programNumber < 1 || programNumber > 255) {
          throw new ModbusError('ATEQ program number must be between 1 and 255');
        }

        await this.client.writeRegister(REGISTERS.EDIT_PROGRAM, swap16(programNumber - 1));
        await new Promise((resolve) => setTimeout(resolve, 300));

        const parameterIds = Object.values(PROGRAM_TIMING_PARAMETER_IDS);
        const requestWords = [parameterIds.length, ...parameterIds].map((value) => swap16(value));
        await this.client.writeRegisters(0x0000, requestWords);
        await new Promise((resolve) => setTimeout(resolve, 150));

        const response = await this.client.readHoldingRegisters(0x0000, parameterIds.length * 3);
        const registers = response.data || [];
        const timingsMs = {};

        for (let index = 0; index < parameterIds.length; index += 1) {
          const baseOffset = index * 3;
          if (baseOffset + 2 >= registers.length) {
            break;
          }

          const parameterId = swap16(registers[baseOffset]);
          const valueMs = decodeSwappedUnsigned32(registers[baseOffset + 1], registers[baseOffset + 2]);
          const fieldName = Object.entries(PROGRAM_TIMING_PARAMETER_IDS)
            .find(([, id]) => id === parameterId)?.[0];

          if (fieldName) {
            timingsMs[fieldName] = normalizeTimingValue(valueMs);
          }
        }

        const identifierPayload = buildProgramTimingsPayload(programNumber, timingsMs, 'parameter-identifiers');
        if (hasCoreProgramTimings(timingsMs)) {
          return {
            ...identifierPayload,
            diagnostics: buildProgramTimingsDiagnostics(identifierPayload, null)
          };
        }

        let directPayload = null;
        try {
          const directReadResponse = await this.client.readHoldingRegisters(0x0400, 9);
          const directRegisters = directReadResponse.data || [];
          const directTimingsMs = {
            fillTime: directRegisters.length > 0 ? normalizeTimingValue(swap16(directRegisters[0])) : null,
            stabTime: directRegisters.length > 1 ? normalizeTimingValue(swap16(directRegisters[1])) : null,
            testTime: directRegisters.length > 2 ? normalizeTimingValue(swap16(directRegisters[2])) : null,
            dumpTime: directRegisters.length > 8 ? normalizeTimingValue(swap16(directRegisters[8])) : null
          };
          directPayload = buildProgramTimingsPayload(programNumber, directTimingsMs, 'direct-registers');
        } catch (directError) {
          directPayload = null;
        }

        if (directPayload && countProgramTimings({
          fillTime: directPayload.fillTimeMs,
          stabTime: directPayload.stabTimeMs,
          testTime: directPayload.testTimeMs,
          dumpTime: directPayload.dumpTimeMs
        }) > 0) {
          return {
            ...directPayload,
            diagnostics: buildProgramTimingsDiagnostics(directPayload, identifierPayload)
          };
        }

        return {
          ...identifierPayload,
          diagnostics: buildProgramTimingsDiagnostics(identifierPayload, directPayload)
        };
      } catch (error) {
        this.connected = false;
        if (error instanceof ModbusError) {
          throw error;
        }

        throw new ModbusError(`ATEQ program timing read failed: ${programNumber}`, error);
      }
    });
  }

  async startTest() {
    return this.execute(async () => {
      try {
        await this.ensureConnected();
        await this.client.writeCoil(REGISTERS.START_COIL, true);
        return { success: true };
      } catch (error) {
        this.connected = false;
        throw new ModbusError('ATEQ start command failed', error);
      }
    });
  }

  async resetDevice() {
    return this.execute(async () => {
      try {
        await this.ensureConnected();
        await this.client.writeCoil(REGISTERS.RESET_COIL, true);
        return { success: true };
      } catch (error) {
        this.connected = false;
        throw new ModbusError('ATEQ reset command failed', error);
      }
    });
  }

}

module.exports = {
  ModbusError,
  REGISTERS,
  UNIT_CODE_MAP,
  ALARM_CODE_MAP,
  STATUS_WORD_FLAGS,
  normalizeUnitLabel,
  describeAlarmCode,
  decodeResultCode,
  decodeErrorCode,
  describeErrorCode,
  describeStatusWord,
  deriveErrorText,
  modbusService: new ModbusService()
};
