// license-ui.js — 试用/激活前端控制（全页面统一加载）
// trial: 全功能 + 右上角小标识（剩余天数）
// full:  全功能 + 右上角"正式版"标识
// expired: 受限模式 —— index 主流程保留(扫码+泄漏测试)，锁定：记录/统计/查询/设置/配置/调试
(function () {
  'use strict';

  var LOCKED_PAGES = [
    '/query.html',
    '/settings.html',
    '/comm-config.html',
    '/ateq-test.html',
    '/scanner-test.html',
    '/plc-test.html'
  ];
  // index 主页面需要变灰的区块（今日统计、最近记录）通过 CSS 隐藏
  var pathName = location.pathname;
  if (pathName === '/' || pathName === '') pathName = '/index.html';
  var isIndex = pathName === '/index.html';
  var isLockedPage = LOCKED_PAGES.indexOf(pathName) !== -1;

  function showError(message) {
    if (window.alert) window.alert(message);
  }

  function api(url, options) {
    return fetch(url, Object.assign({ cache: 'no-store', headers: { 'Content-Type': 'application/json' } }, options || {}))
      .then(function (response) {
        return response.json().catch(function () { return null; }).then(function (payload) {
          if (!response.ok) {
            var err = new Error((payload && payload.message) || url + ' ' + response.status);
            err.payload = payload;
            throw err;
          }
          return payload;
        });
      });
  }

  function loadLicense() {
    return api('/api/license');
  }

  /* ---------- 顶部/角落标识 ---------- */
  function ensureBadge() {
    var existing = document.getElementById('ateq-license-badge');
    if (existing) return existing;
    var badge = document.createElement('div');
    badge.id = 'ateq-license-badge';
    badge.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:2147483000;padding:3px 10px;border-radius:12px;' +
      'font:12px/18px "Microsoft YaHei",sans-serif;cursor:pointer;user-select:none;' +
      'background:rgba(10,20,30,.82);color:#bcd3e6;border:1px solid #29506f;';
    document.body.appendChild(badge);
    return badge;
  }

  function renderBadge(mode, daysLeft) {
    var badge = ensureBadge();
    var text, color;
    if (mode === 'full') {
      text = '正式版';
      color = '#34c67a';
    } else if (mode === 'trial') {
      text = '试用版 · 剩 ' + daysLeft + ' 天';
      color = '#e8c15a';
    } else {
      text = '试用已到期 · 点击激活';
      color = '#ff5d5d';
    }
    badge.textContent = text;
    badge.style.color = color;
    badge.style.borderColor = color;
    badge.onclick = function () { openActivationModal(mode === 'expired'); };
  }

  /* ---------- 受限模式横幅（index 保留主流程时的提示条） ---------- */
  function showLimitedBanner() {
    if (document.getElementById('ateq-license-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'ateq-license-banner';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147482000;' +
      'background:#5a1e1e;color:#ffd7d7;font:13px/20px "Microsoft YaHei",sans-serif;' +
      'text-align:center;padding:6px 90px 6px 12px;box-shadow:0 2px 8px rgba(0,0,0,.4);';
    banner.innerHTML =
      '试用期已结束：当前为受限模式，仅保留扫码读取与泄漏测试；正式版功能（记录查询/导出/设置/通讯配置）已锁定。' +
      '<span id="ateq-license-act-btn" style="cursor:pointer;color:#ffd24a;text-decoration:underline;margin-left:8px;">输入激活码</span>';
    document.body.appendChild(banner);
    document.getElementById('ateq-license-act-btn').onclick = function () {
      openActivationModal(true);
    };
    if (isIndex) {
      document.body.style.paddingTop = '30px';
    }
    applyExpiredCss();
  }

  /* ---------- 锁定页全屏遮罩（query/settings/comm-config/调试页） ---------- */
  function showLockedOverlay() {
    if (document.getElementById('ateq-license-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'ateq-license-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(4,10,16,.92);';
    overlay.innerHTML =
      '<div style="max-width:520px;width:90%;background:#12263a;border:1px solid #3a5f7d;border-radius:10px;' +
      'padding:26px 24px;color:#e7f1fa;font-family:"Microsoft YaHei",sans-serif;">' +
      '<div style="font-size:18px;font-weight:bold;color:#ff8a8a;margin-bottom:10px;">正式版功能已锁定</div>' +
      '<div style="font-size:13px;line-height:1.8;color:#a9c4da;margin-bottom:14px;">' +
      '当前为受限模式，仅保留扫码读取与泄漏测试。数据查询、记录导出、系统设置与通讯配置属于正式版功能，' +
      '需要输入厂家提供的激活码后使用。<br>如已付款，请联系厂家获取本机激活码。</div>' +
      '<div style="font-size:13px;color:#8fb4cf;margin-bottom:6px;">本机机器码：</div>' +
      '<div id="ateq-lic-machine" style="font-family:Consolas,monospace;font-size:15px;color:#ffd24a;' +
      'background:#0b1a28;border:1px solid #2a4a66;padding:8px 10px;border-radius:6px;margin-bottom:14px;user-select:all;"></div>' +
      '<input id="ateq-lic-input" placeholder="请输入激活码" autocomplete="off" spellcheck="false" ' +
      'style="width:100%;box-sizing:border-box;background:#0b1a28;color:#e7f1fa;border:1px solid #2a4a66;' +
      'border-radius:6px;padding:10px;font-family:Consolas,monospace;font-size:16px;margin-bottom:14px;">' +
      '<div style="display:flex;gap:10px;">' +
      '<button id="ateq-lic-submit" style="flex:1;background:#1f8f5a;color:#fff;border:none;border-radius:6px;padding:10px;font-size:15px;cursor:pointer;">激活</button>' +
      '<button id="ateq-lic-back" style="flex:1;background:#34506a;color:#cfe2f2;border:none;border-radius:6px;padding:10px;font-size:15px;cursor:pointer;">返回主测试页</button>' +
      '</div>' +
      '<div id="ateq-lic-msg" style="margin-top:10px;font-size:13px;color:#ffb0b0;min-height:18px;"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    document.getElementById('ateq-lic-submit').onclick = doActivate;
    document.getElementById('ateq-lic-input').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') doActivate();
    });
    document.getElementById('ateq-lic-back').onclick = function () {
      location.href = '/';
    };
  }

  /* ---------- 激活弹窗（通用） ---------- */
  function openActivationModal(forceExpired) {
    var current = document.getElementById('ateq-license-modal');
    if (current) current.remove();

    loadLicense().then(function (status) {
      var lic = status.license || {};
      var modal = document.createElement('div');
      modal.id = 'ateq-license-modal';
      modal.style.cssText =
        'position:fixed;inset:0;z-index:2147484000;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(4,10,16,.9);';
      modal.innerHTML =
        '<div style="max-width:480px;width:90%;background:#12263a;border:1px solid #3a5f7d;border-radius:10px;' +
        'padding:24px 22px;color:#e7f1fa;font-family:"Microsoft YaHei",sans-serif;">' +
        '<div style="font-size:18px;font-weight:bold;color:#ffd24a;margin-bottom:10px;">软件激活</div>' +
        '<div style="font-size:13px;line-height:1.8;color:#a9c4da;margin-bottom:12px;">' +
        '请将下面的机器码发送给厂家，获取与这台电脑绑定的激活码后输入。</div>' +
        '<div style="font-size:13px;color:#8fb4cf;margin-bottom:6px;">本机机器码：</div>' +
        '<div style="font-family:Consolas,monospace;font-size:15px;color:#ffd24a;background:#0b1a28;' +
        'border:1px solid #2a4a66;padding:8px 10px;border-radius:6px;margin-bottom:14px;user-select:all;" id="ateq-modal-machine">' +
        (lic.machineCodeDisplay || '') + '</div>' +
        '<input id="ateq-modal-input" placeholder="请输入激活码" autocomplete="off" spellcheck="false" ' +
        'style="width:100%;box-sizing:border-box;background:#0b1a28;color:#e7f1fa;border:1px solid #2a4a66;' +
        'border-radius:6px;padding:10px;font-family:Consolas,monospace;font-size:16px;margin-bottom:14px;">' +
        '<div style="display:flex;gap:10px;">' +
        '<button id="ateq-modal-submit" style="flex:1;background:#1f8f5a;color:#fff;border:none;border-radius:6px;padding:10px;font-size:15px;cursor:pointer;">确认激活</button>' +
        '<button id="ateq-modal-close" style="flex:1;background:#34506a;color:#cfe2f2;border:none;border-radius:6px;padding:10px;font-size:15px;cursor:pointer;">关闭</button>' +
        '</div>' +
        '<div id="ateq-modal-msg" style="margin-top:10px;font-size:13px;color:#ffb0b0;min-height:18px;"></div>' +
        '</div>';
      document.body.appendChild(modal);

      document.getElementById('ateq-modal-submit').onclick = function () {
        var code = document.getElementById('ateq-modal-input').value;
        doActivateWith(code, document.getElementById('ateq-modal-msg'));
      };
      document.getElementById('ateq-modal-input').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          var val = document.getElementById('ateq-modal-input').value;
          doActivateWith(val, document.getElementById('ateq-modal-msg'));
        }
      });
      document.getElementById('ateq-modal-close').onclick = function () { modal.remove(); };
      if (forceExpired && isLockedPage) {
        document.getElementById('ateq-modal-close').style.display = 'none';
      }
    }).catch(function (error) {
      showError('无法读取许可证状态：' + error.message);
    });
  }

  function doActivate() {
    var input = document.getElementById('ateq-lic-input');
    var msg = document.getElementById('ateq-lic-msg');
    doActivateWith(input ? input.value : '', msg);
  }

  function doActivateWith(code, msgElement) {
    api('/api/license/activate', {
      method: 'POST',
      body: JSON.stringify({ code: code })
    }).then(function (payload) {
      if (payload && payload.success) {
        if (msgElement) msgElement.textContent = '激活成功！正在刷新…';
        setTimeout(function () { location.reload(); }, 800);
      } else {
        if (msgElement) msgElement.textContent = (payload && payload.message) || '激活失败';
      }
    }).catch(function (error) {
      if (msgElement) msgElement.textContent = error.message;
    });
  }

  /* ---------- 受限模式 CSS（index 变灰锁定区块与导航） ---------- */
  function applyExpiredCss() {
    var styleId = 'ateq-license-css';
    if (document.getElementById(styleId)) return;
    var style = document.createElement('style');
    style.id = styleId;
    style.textContent =
      'body.lic-expired .today-panel, body.lic-expired .records-panel {' +
      '  display:none !important;' +
      '}' +
      'body.lic-expired a[href="/query.html"],' +
      'body.lic-expired a[href="/settings.html"],' +
      'body.lic-expired a[href="/comm-config.html"] {' +
      '  opacity:.45;' +
      '  cursor:not-allowed;' +
      '  pointer-events:none;' +
      '}' +
      'body.lic-expired .lic-lock-note {' +
      '  display:block;' +
      '}';
    document.head.appendChild(style);
  }

  function addLockNote() {
    if (!isIndex) return;
    var note = document.createElement('div');
    note.className = 'lic-lock-note';
    note.style.cssText =
      'display:none;padding:10px 14px;margin:8px 14px;background:#3a2626;border:1px dashed #b05656;' +
      'border-radius:8px;color:#ffc9c9;font:13px/1.7 "Microsoft YaHei",sans-serif;';
    note.innerHTML = '正式版功能已锁定：数据查询 / 记录导出 / 系统设置 / 通讯配置需激活后使用。当前仍可扫码并执行泄漏测试。';
    document.body.insertBefore(note, document.body.firstChild);
  }

  /* ---------- 启动 ---------- */
  function init() {
    addLockNote();
    loadLicense().then(function (status) {
      var lic = status.license || {};
      var mode = lic.mode || 'trial';
      renderBadge(mode, lic.daysLeft);
      if (mode === 'expired') {
        document.body.classList.add('lic-expired');
        if (isIndex) {
          showLimitedBanner();
        } else if (isLockedPage) {
          showLockedOverlay();
        }
      } else if (mode === 'trial' && isIndex && lic.daysLeft <= 7) {
        // 试用临期提示（可选），暂不打扰
      }
    }).catch(function () {
      // 状态读取失败时静默，不阻断主流程
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
