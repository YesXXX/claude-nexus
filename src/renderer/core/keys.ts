/**
 * 按键组合的解析、匹配与展示（纯函数，不访问 DOM）。
 * 组合写法：修饰键 + 主键，用 + 或空格分隔，如 'Ctrl+Shift+D'、'Ctrl ⇧ D'、'Esc'。
 * 修饰键固定按 Ctrl、Alt、Shift、Meta 的顺序规范化；主键字母统一大写，数字键按物理键位（Digit1）识别。
 */

/** 匹配所需的键盘事件字段，单测可以直接传普通对象 */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

const ALIASES: Record<string, string> = {
  control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', '⇧': 'Shift',
  meta: 'Meta', win: 'Meta', cmd: 'Meta',
  esc: 'Esc', escape: 'Esc', enter: 'Enter', return: 'Enter', space: 'Space', ' ': 'Space',
  tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
};

function canon(token: string): string {
  const a = ALIASES[token.toLowerCase()];
  if (a) return a;
  return token.length === 1 ? token.toUpperCase() : token[0].toUpperCase() + token.slice(1);
}

/** 把组合写法规范化为 'Ctrl+Shift+D' 形式；空串返回空串 */
export function normalizeCombo(spec: string): string {
  const tokens = spec.split(/[+\s]+/).filter(Boolean).map(canon);
  const mods = MODS.filter(m => tokens.includes(m));
  const rest = tokens.filter(t => !(MODS as readonly string[]).includes(t));
  return [...mods, ...rest].join('+');
}

/** 键盘事件对应的规范化组合，如 Ctrl+Shift+D；数字键取物理键位，不受 Shift 影响 */
export function combo(e: KeyLike): string {
  const mods = MODS.filter(m => (m === 'Ctrl' ? e.ctrlKey : m === 'Alt' ? e.altKey : m === 'Shift' ? e.shiftKey : e.metaKey));
  let main: string;
  if (/^Digit\d$/.test(e.code)) main = e.code.slice(5);
  else if (/^Key[A-Z]$/.test(e.code) && e.key.length !== 1) main = e.code.slice(3);
  else main = canon(e.key);
  if ((MODS as readonly string[]).includes(main)) return mods.join('+');
  return [...mods, main].join('+');
}

/** 事件是否恰好是该组合（修饰键必须完全一致） */
export function matchCombo(e: KeyLike, spec: string): boolean {
  return combo(e) === normalizeCombo(spec);
}

/** 展示文本：'Ctrl+Shift+D' → 'Ctrl ⇧ D' */
export function formatCombo(spec: string): string {
  return normalizeCombo(spec).split('+').map(t => (t === 'Shift' ? '⇧' : t)).join(' ');
}

/**
 * 热键展示文本的规范化形式，用于判重：大小写、⇧ 与 Shift、空格与 + 视为相同。
 * 展示文本可能是若干个并列键（'Y N A'）或范围（'Ctrl 1~9'），这里只做逐词规范化、不重排。
 */
export function normalizeKeys(keys: string): string {
  return keys.split(/[+\s]+/).filter(Boolean).map(canon).join(' ');
}
