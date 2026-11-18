// 6 位支付 PIN 输入：把页面里现成的 <input maxlength="6" inputmode="numeric"> 原地升级成
// 「6 个格子 + 一个覆盖在上面的透明输入框」——成熟支付产品（Stripe Elements、支付宝）的通行做法。
//
// 为什么不在 6 个输入框之间跳焦点：逐格焦点在移动端输入法、语音输入、自动填充下很容易错位；
// 用一个真实输入框承载全部输入，粘贴、删改、密码管理器都能原生工作，格子只负责显示。
// 约定：不改调用方的取值方式，读写 input.value 照旧（内部用 value 的 setter 钩子同步格子）。
(function () {
  'use strict';
  if (window.__pinReady) return;
  window.__pinReady = true;

  const PIN_LEN = 6;
  const SELECTOR = 'input[data-pin], input[type="password"][inputmode="numeric"][maxlength="6"]';

  function cells(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('<span class="pin-cell" aria-hidden="true"></span>');
    return out.join('');
  }

  function upgrade(input) {
    if (input.dataset.pinReady) return;
    if (input.readOnly || input.disabled) return;
    input.dataset.pinReady = '1';
    input.maxLength = PIN_LEN;
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('pattern', '[0-9]*');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    // 移动节点会让正在聚焦的元素失焦，先记下来，升级完再还原
    const hadFocus = document.activeElement === input;
    const wrap = document.createElement('div');
    wrap.className = 'pin-field';
    const box = document.createElement('div');
    box.className = 'pin-boxes';
    box.innerHTML = cells(PIN_LEN);
    wrap.appendChild(box);
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    if (hadFocus) input.focus();

    const cellEls = Array.from(box.children);
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const nativeGet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get;

    function render() {
      const val = nativeGet.call(input) || '';
      const focused = document.activeElement === input;
      const pos = focused ? (input.selectionStart === null ? val.length : input.selectionStart) : -1;
      cellEls.forEach((el, i) => {
        // 已输入显示实心圆点（不显示明文），正在输入的那一格加高亮边框
        el.textContent = i < val.length ? '●' : '';
        el.classList.toggle('filled', i < val.length);
        el.classList.toggle('active', focused && (pos === i || (pos === val.length && i === Math.min(val.length, PIN_LEN - 1))));
      });
      wrap.classList.toggle('complete', val.length === PIN_LEN);
      wrap.classList.toggle('has-error', false);
    }

    // 读写 value 都走同一个入口：调用方 $('x').value = '' 时格子也会跟着清空
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return nativeGet.call(this); },
      set(v) {
        const digits = String(v === null || v === undefined ? '' : v).replace(/\D/g, '').slice(0, PIN_LEN);
        nativeSet.call(this, digits);
        render();
      },
    });

    function sanitize() {
      const raw = nativeGet.call(input) || '';
      const digits = raw.replace(/\D/g, '').slice(0, PIN_LEN);
      if (digits !== raw) nativeSet.call(input, digits);
      render();
      input.dispatchEvent(new CustomEvent('pin:change', { detail: { value: digits, complete: digits.length === PIN_LEN } }));
    }

    input.addEventListener('input', sanitize);
    input.addEventListener('focus', () => {
      wrap.classList.add('focused');
      render();
      // 光标固定到末尾，避免点中间格子后输入位置错乱
      requestAnimationFrame(() => {
        const len = (nativeGet.call(input) || '').length;
        try { input.setSelectionRange(len, len); } catch (_) { /* 部分内核不支持 */ }
        render();
      });
    });
    input.addEventListener('blur', () => {
      wrap.classList.remove('focused');
      setTimeout(render, 0);
    });
    input.addEventListener('keyup', render);
    input.addEventListener('click', render);
    // 点击任意格子都能唤起输入框
    box.addEventListener('click', (e) => { e.preventDefault(); input.focus(); });
    render();

    // 供调用方在服务端返回错误时调用：抖动 + 清空，用户可直接重输
    input.addEventListener('pin:shake', () => {
      const val = nativeGet.call(input) || '';
      if (val) {
        nativeSet.call(input, '');
        render();
      }
      wrap.classList.remove('shake');
      void wrap.offsetWidth; // 强制重排，让动画可重复触发
      wrap.classList.add('shake', 'has-error');
      setTimeout(() => wrap.classList.remove('shake'), 420);
      input.focus();
    });
  }

  function upgradeAll(root) {
    (root || document).querySelectorAll(SELECTOR).forEach(upgrade);
  }

  window.pinShake = function (el) {
    const input = typeof el === 'string' ? document.getElementById(el) : el;
    if (input && input.dispatchEvent) input.dispatchEvent(new Event('pin:shake'));
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => upgradeAll());
  else upgradeAll();
})();
