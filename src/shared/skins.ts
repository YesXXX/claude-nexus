/**
 * 界面皮肤清单：主进程（启动首帧底色、系统窗口按钮颜色、偏好校验）与渲染层（设置页卡片、命令面板）共用。
 * 每套皮肤的完整配色在 src/renderer/skins.css（石墨即 renderer.css 的 :root 默认值），
 * 这里只放 CSS 之外也要用到的几个色值；两边一致由单测保证。
 */

export type SkinId = 'graphite' | 'midnight' | 'warm';

export interface SkinInfo {
  id: SkinId;
  name: string;
  /** 一句话说明，设置页卡片下方 */
  hint: string;
  /** 标题栏与导航轨底色，等于皮肤的 --chrome；窗口首帧底色与系统按钮区背景都用它 */
  chrome: string;
  /** 系统最小化 / 最大化 / 关闭按钮的图标颜色 */
  symbol: string;
  /** 设置页缩略卡片的四个色块：外框、面板、终端、强调色 */
  preview: { chrome: string; panel: string; term: string; accent: string };
}

export const SKINS: readonly SkinInfo[] = [
  {
    id: 'graphite', name: '石墨', hint: '默认的黑白灰，彩色只留给状态',
    chrome: '#0e0e0e', symbol: '#a3a3a3',
    preview: { chrome: '#0e0e0e', panel: '#161616', term: '#0d0d0d', accent: '#f4f4f4' },
  },
  {
    id: 'midnight', name: '夜蓝', hint: '冷色深底，强调色偏蓝',
    chrome: '#0b0f17', symbol: '#9aa8bf',
    preview: { chrome: '#0b0f17', panel: '#0f1520', term: '#0a0e15', accent: '#8fb8ff' },
  },
  {
    id: 'warm', name: '暖灰', hint: '暖色深底，久看更柔和',
    chrome: '#161412', symbol: '#b3a99c',
    preview: { chrome: '#161412', panel: '#1b1916', term: '#141210', accent: '#e3a77a' },
  },
];

export const DEFAULT_SKIN: SkinId = 'graphite';

export function isSkinId(v: unknown): v is SkinId {
  return typeof v === 'string' && SKINS.some(s => s.id === v);
}

/** 按 id 取皮肤；未知 id 回退默认皮肤 */
export function skinOf(id: unknown): SkinInfo {
  return SKINS.find(s => s.id === id) ?? SKINS[0];
}
