// 收款二维码：把结账链接编码成 QR，直接输出 SVG 字符串。
//
// 为什么自己拼 SVG：qrcode 只负责生成模块矩阵（纯计算），SVG 由字符串拼出来既没有栅格化依赖，
// 也能在任意尺寸下保持锐利。同一份 payload 既能给 <img src> 用，也能内联进 JSON 给商户直接拿走。
'use strict';

const QRCode = require('qrcode');

const DEFAULT_SIZE = 256;
const DEFAULT_MARGIN = 2; // 静区（单位：模块）。规范建议 4，屏幕展示用 2 更紧凑且仍可稳定识别

/**
 * 生成二维码 SVG。
 * @param {string} text 二维码内容
 * @param {{size?: number, margin?: number, errorCorrectionLevel?: 'L'|'M'|'Q'|'H', dark?: string, light?: string}} [opts]
 * @returns {string} 完整 <svg> 字符串
 */
function toSvg(text, opts = {}) {
  const value = String(text || '');
  if (!value) throw new TypeError('二维码内容不能为空');
  if (value.length > 1200) throw new TypeError('二维码内容过长');
  const size = Number.isFinite(opts.size) && opts.size > 0 ? Math.round(opts.size) : DEFAULT_SIZE;
  const margin = Number.isInteger(opts.margin) && opts.margin >= 0 ? opts.margin : DEFAULT_MARGIN;
  const dark = opts.dark || '#000000';
  const light = opts.light || '#FFFFFF';

  const mods = QRCode.create(value, { errorCorrectionLevel: opts.errorCorrectionLevel || 'M' }).modules;
  const count = mods.size;
  const total = count + margin * 2;

  // 同一行连续的暗模块合并成一条横线，路径比逐格拼接短很多（约 1/4 体积）
  let path = '';
  for (let row = 0; row < count; row++) {
    let col = 0;
    while (col < count) {
      if (!mods.get(row, col)) { col++; continue; }
      let len = 1;
      while (col + len < count && mods.get(row, col + len)) len++;
      path += `M${col + margin} ${row + margin}h${len}v1h-${len}z`;
      col += len;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="收款二维码"><rect width="${total}" height="${total}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

module.exports = { toSvg, DEFAULT_SIZE, DEFAULT_MARGIN };
