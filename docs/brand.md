# SpacePay 标识

| 文件 | 用途 |
| --- | --- |
| `public/brand/spacepay-mark-light.svg` | 符号，浅色背景 |
| `public/brand/spacepay-mark-dark.svg` | 符号，深色背景 |
| `public/brand/spacepay-logo-light.svg` | 符号 + 字标，浅色背景 |
| `public/brand/spacepay-logo-dark.svg` | 符号 + 字标，深色背景 |
| `public/brand/favicon.svg` | 浏览器图标，随系统深浅色自动切换（SVG 内 `prefers-color-scheme`） |

网页中使用：

```html
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<img src="/brand/spacepay-logo-light.svg" alt="SpacePay" height="28">
```

## 设计理念

两个同尺寸的半圆上下错开，代表付款方与收款方；错位的方向是资金流向，两半合起来是字母 S 的轮廓。只有两个几何元素、没有描边和渐变，所以在 16px 下仍能分辨上下两色，在 512px 下边缘依然干净。

## 配色

| 角色 | 浅色版 | 深色版 |
| --- | --- | --- |
| 品牌色（上半圆，也是界面里唯一的强调色） | `#1F55E0` | `#7096FF` |
| 墨色（下半圆、字标） | `#0E1726` | `#F2F4F7` |

## 使用规则

- 留白：四周至少留出符号宽度的 1/4。
- 最小尺寸：符号 16px；带字标的组合 80px 宽。
- 不要旋转、拉伸、加阴影或渐变，不要改两半的颜色顺序。
- 字标 `SpacePay` 用 SVG `<text>` 写成（Inter / Helvetica Neue / Arial 回退）。印刷或其他需要固定字形的场景，请先在设计工具中把文字转成轮廓再导出。
