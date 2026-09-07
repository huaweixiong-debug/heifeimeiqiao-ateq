#!/usr/bin/env node
// gen-license.js — 厂家离线激活码生成工具（一机一码）
//
// 用法（在装有本项目的电脑上运行，可自动读取本机的 data/license.secret）：
//   node tools/gen-license.js                 # 显示本机机器码 + 本机激活码
//   node tools/gen-license.js <机器码>         # 为指定机器码计算激活码（异地发码）
//
// 密钥来源与 license.js 一致：
//   env ATEQ_LICENSE_SECRET  >  data/license.secret（默认，已被 .gitignore 忽略）
// 若两处都没有密钥（例如把工具拷到没有 secret 的电脑上运行），会明确报错，
// 绝不使用内置密钥兜底，避免客户自行发码。
'use strict';

const path = require('path');

function main() {
  const license = require(path.join(__dirname, '..', 'license.js'));

  const arg = process.argv[2];
  const machineCode = arg ? String(arg).replace(/[^0-9A-Fa-f]/g, '').toUpperCase() : null;
  if (machineCode && machineCode.length !== 32) {
    console.error('[错误] 机器码格式不正确：需要 32 位十六进制（可带连字符）。');
    process.exit(1);
  }

  if (machineCode) {
    const code = license.computeActivationCode(machineCode, license.getSecret());
    console.log('机器码  : ' + license.formatMachineCode(machineCode));
    console.log('激活码  : ' + license.formatActivationCode(code));
    return;
  }

  const local = license.getMachineCode();
  const code = license.computeActivationCode(local, license.getSecret());
  console.log('本机机器码: ' + license.formatMachineCode(local));
  console.log('本机激活码: ' + license.formatActivationCode(code));
}

try {
  main();
} catch (error) {
  console.error('[错误] 生成失败：' + (error && error.message ? error.message : String(error)));
  process.exit(1);
}
