// SpacePay 图表：纯 SVG，无第三方依赖。
// 规范：每张图在卡片标题里写明指标与单位，图下标注统计周期与坐标轴含义；
// 多序列时有图例；细线、无 3D、无渐变；悬停显示十字线与数值。颜色取 CSS 变量（--chart-1 / --chart-2）。
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const registry = new Map(); // el -> 渲染函数，用于窗口尺寸变化时重绘

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }
  function ticks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const step = niceStep(max - min, count);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  function el(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function setup(container, height) {
    container.innerHTML = '';
    const width = Math.max(280, container.clientWidth || 600);
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
    container.appendChild(svg);
    const tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    tip.hidden = true;
    container.appendChild(tip);
    return { svg, tip, width, height };
  }

  function empty(container, height, text) {
    const { svg, width } = setup(container, height);
    svg.appendChild(el('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'empty-text' }, text || '暂无数据'));
  }

  function showTip(tip, container, x, y, title, rows) {
    tip.innerHTML = `<div class="t-title">${esc(title)}</div>` + rows.map((r) => `<div class="t-row"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('');
    tip.hidden = false;
    const cw = container.clientWidth;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(0, x + 12), cw - tw) + 'px';
    tip.style.top = Math.max(0, y - 10) + 'px';
  }

  function register(container, fn) {
    registry.set(container, fn);
    fn();
  }
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { for (const [c, fn] of registry) if (c.isConnected && c.offsetParent !== null) fn(); }, 150);
  });

  /**
   * 折线图。opts: { series: [{ name, cls: 'line-1'|'line-2', values: number[] }], xLabels: string[],
   *   format(v) 数值格式（tooltip/直接标注）, axisFormat(v) 纵轴刻度格式, yTitle, xTitle, height, emptyText }
   */
  function line(container, opts) {
    register(container, () => {
      const height = opts.height || 260;
      const n = opts.xLabels.length;
      if (n < 2 || !opts.series.length) return empty(container, height, opts.emptyText || '数据不足，至少需要两个数据点');
      const { svg, tip, width } = setup(container, height);
      const pad = { l: 64, r: 16, t: 12, b: 40 };
      const all = opts.series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
      let min = Math.min(...all), max = Math.max(...all);
      const nonNegative = min >= 0;
      const span = max - min || Math.abs(max) || 1;
      min -= span * 0.08; max += span * 0.08;
      if (nonNegative && min < 0) min = 0; // 金额类数据不画出负数刻度
      const yt = ticks(min, max, 4);
      min = yt[0]; max = yt[yt.length - 1];
      const X = (i) => pad.l + ((width - pad.l - pad.r) * i) / (n - 1);
      const Y = (v) => pad.t + ((height - pad.t - pad.b) * (max - v)) / (max - min);
      for (const t of yt) {
        svg.appendChild(el('line', { x1: pad.l, x2: width - pad.r, y1: Y(t), y2: Y(t), class: 'grid-line' }));
        svg.appendChild(el('text', { x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end', class: 'axis-text' }, (opts.axisFormat || opts.format)(t, Math.max(...yt.map(Math.abs)))));
      }
      const every = Math.max(1, Math.ceil(n / Math.floor((width - pad.l - pad.r) / 70)));
      for (let i = 0; i < n; i += every) svg.appendChild(el('text', { x: X(i), y: height - pad.b + 16, 'text-anchor': 'middle', class: 'axis-text' }, opts.xLabels[i]));
      if (opts.xTitle) svg.appendChild(el('text', { x: width - pad.r, y: height - 4, 'text-anchor': 'end', class: 'axis-title' }, opts.xTitle));
      if (opts.yTitle) svg.appendChild(el('text', { x: 4, y: 10, class: 'axis-title' }, opts.yTitle));
      // 次要序列先画，主序列在上层
      for (const s of [...opts.series].reverse()) {
        let d = '';
        s.values.forEach((v, i) => { if (v === null || v === undefined) return; d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); });
        svg.appendChild(el('path', { d, class: s.cls }));
      }
      // 主序列末点直接标注（只标一个点，不在每个点上写数字）
      const main = opts.series[0];
      const lastI = main.values.length - 1;
      svg.appendChild(el('circle', { cx: X(lastI), cy: Y(main.values[lastI]), r: 4, class: 'dot-1' }));
      svg.appendChild(el('text', { x: X(lastI) - 6, y: Y(main.values[lastI]) - 10, 'text-anchor': 'end', class: 'label' }, opts.format(main.values[lastI])));
      // 悬停：十字线 + 数值
      const cross = el('line', { y1: pad.t, y2: height - pad.b, class: 'crosshair', visibility: 'hidden' });
      const dots = opts.series.map((s, k) => el('circle', { r: 4, class: k === 0 ? 'dot-1' : 'dot-2', visibility: 'hidden' }));
      svg.appendChild(cross); dots.forEach((d) => svg.appendChild(d));
      const hit = el('rect', { x: pad.l, y: pad.t, width: width - pad.l - pad.r, height: height - pad.t - pad.b, fill: 'transparent' });
      svg.appendChild(hit);
      const move = (evt) => {
        const rect = svg.getBoundingClientRect();
        const px = ((evt.clientX - rect.left) / rect.width) * width;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (n - 1))));
        cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
        opts.series.forEach((s, k) => {
          const v = s.values[i];
          if (v === null || v === undefined) { dots[k].setAttribute('visibility', 'hidden'); return; }
          dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(v)); dots[k].setAttribute('visibility', 'visible');
        });
        showTip(tip, container, (X(i) / width) * rect.width, (pad.t / height) * rect.height, opts.xLabels[i], opts.series.map((s) => [s.name, s.values[i] === null || s.values[i] === undefined ? '—' : opts.format(s.values[i])]));
      };
      hit.addEventListener('pointermove', move);
      hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); });
    });
  }

  /** 横向条形图（单序列、从 0 起）。opts: { items: [{ label, value, note }], format, height? } */
  function hbar(container, opts) {
    register(container, () => {
      const items = opts.items.filter((x) => x.value > 0);
      const rowH = 32;
      const height = Math.max(80, items.length * rowH + 28);
      if (!items.length) return empty(container, 80, opts.emptyText || '暂无数据');
      const { svg, tip, width } = setup(container, height);
      const pad = { l: 64, r: 150, t: 4, b: 24 };
      const max = Math.max(...items.map((x) => x.value));
      const xt = ticks(0, max, 3);
      const W = width - pad.l - pad.r;
      const X = (v) => pad.l + (W * v) / xt[xt.length - 1];
      for (const t of xt) {
        svg.appendChild(el('line', { x1: X(t), x2: X(t), y1: pad.t, y2: height - pad.b, class: 'grid-line' }));
        svg.appendChild(el('text', { x: X(t), y: height - 6, 'text-anchor': 'middle', class: 'axis-text' }, opts.axisFormat ? opts.axisFormat(t, xt[xt.length - 1]) : opts.format(t)));
      }
      items.forEach((it, i) => {
        const y = pad.t + i * rowH + 6;
        svg.appendChild(el('text', { x: pad.l - 8, y: y + 14, 'text-anchor': 'end', class: 'axis-text' }, it.label));
        const w = Math.max(2, X(it.value) - pad.l);
        const bar = el('rect', { x: pad.l, y, width: w, height: 20, rx: 2, class: 'bar-1' });
        svg.appendChild(bar);
        svg.appendChild(el('text', { x: pad.l + w + 8, y: y + 14, class: 'label' }, opts.format(it.value) + (it.note ? '  ' + it.note : '')));
        bar.addEventListener('pointermove', (evt) => {
          const r = container.getBoundingClientRect();
          showTip(tip, container, evt.clientX - r.left, evt.clientY - r.top - 40, it.label, [['金额', opts.format(it.value)], ...(it.note ? [['占比', it.note]] : [])]);
        });
        bar.addEventListener('pointerleave', () => { tip.hidden = true; });
      });
    });
  }

  /** 分组柱状图（从 0 起）。opts: { categories: string[], series: [{ name, cls, values }], format, axisFormat, height } */
  function columns(container, opts) {
    register(container, () => {
      const height = opts.height || 260;
      const n = opts.categories.length;
      if (!n) return empty(container, height);
      const { svg, tip, width } = setup(container, height);
      const pad = { l: 64, r: 12, t: 12, b: 40 };
      const max = Math.max(1, ...opts.series.flatMap((s) => s.values));
      const yt = ticks(0, max, 4);
      const top = yt[yt.length - 1];
      const Y = (v) => pad.t + ((height - pad.t - pad.b) * (top - v)) / top;
      for (const t of yt) {
        svg.appendChild(el('line', { x1: pad.l, x2: width - pad.r, y1: Y(t), y2: Y(t), class: 'grid-line' }));
        svg.appendChild(el('text', { x: pad.l - 8, y: Y(t) + 4, 'text-anchor': 'end', class: 'axis-text' }, (opts.axisFormat || opts.format)(t, top)));
      }
      const band = (width - pad.l - pad.r) / n;
      const gap = 2; // 相邻柱之间留 2px
      const bw = Math.max(2, Math.min(18, (band * 0.7 - gap * (opts.series.length - 1)) / opts.series.length));
      const every = Math.max(1, Math.ceil(n / Math.floor((width - pad.l - pad.r) / 56)));
      opts.categories.forEach((c, i) => {
        const x0 = pad.l + band * i + (band - (bw * opts.series.length + gap * (opts.series.length - 1))) / 2;
        opts.series.forEach((s, k) => {
          const v = s.values[i];
          const h = Math.max(v > 0 ? 1 : 0, Y(0) - Y(v));
          svg.appendChild(el('rect', { x: x0 + k * (bw + gap), y: Y(0) - h, width: bw, height: h, rx: 1, class: s.cls }));
        });
        if (i % every === 0) svg.appendChild(el('text', { x: pad.l + band * i + band / 2, y: height - pad.b + 16, 'text-anchor': 'middle', class: 'axis-text' }, c.slice(5)));
        const hit = el('rect', { x: pad.l + band * i, y: pad.t, width: band, height: height - pad.t - pad.b, fill: 'transparent' });
        hit.addEventListener('pointermove', (evt) => {
          const r = container.getBoundingClientRect();
          showTip(tip, container, evt.clientX - r.left, pad.t, c, opts.series.map((s) => [s.name, opts.format(s.values[i])]));
        });
        hit.addEventListener('pointerleave', () => { tip.hidden = true; });
        svg.appendChild(hit);
      });
      svg.appendChild(el('line', { x1: pad.l, x2: width - pad.r, y1: Y(0), y2: Y(0), stroke: 'var(--chart-axis)' }));
      if (opts.xTitle) svg.appendChild(el('text', { x: width - pad.r, y: height - 4, 'text-anchor': 'end', class: 'axis-title' }, opts.xTitle));
    });
  }

  /** 迷你走势（表格内），颜色表示首尾涨跌，表格另有涨跌数字与符号 */
  function spark(values, w = 80, h = 24) {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const d = values.map((v, i) => (i ? 'L' : 'M') + ((w * i) / (values.length - 1)).toFixed(1) + ' ' + (2 + ((h - 4) * (max - v)) / span).toFixed(1)).join('');
    const up = values[values.length - 1] >= values[0];
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="${up ? 's-up' : 's-down'}" d="${d}"/></svg>`;
  }

  window.Charts = { line, hbar, columns, spark };
})();
