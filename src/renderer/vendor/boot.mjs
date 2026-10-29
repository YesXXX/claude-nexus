// 把 ansi_up、xterm、FitAddon 与 SearchAddon 挂到 window，让 renderer.js 同步可用。
// 单独成文件而不是写在 index.html 里：页面的内容安全策略只允许加载同目录下的脚本文件，不允许内联脚本。
import { AnsiUp } from './ansi_up.js';
import { Terminal } from './xterm.mjs';
import { FitAddon } from './addon-fit.mjs';
import { SearchAddon } from './addon-search.mjs';

window.AnsiUp = AnsiUp;
window.dispatchEvent(new Event('ansi-up-ready'));
window.Terminal = Terminal;
window.FitAddon = FitAddon;
window.SearchAddon = SearchAddon;
window.dispatchEvent(new Event('xterm-ready'));
