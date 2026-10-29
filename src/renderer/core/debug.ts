/** 调试日志：按标签分类，方便从 DevTools 复制反馈 */

/** 会话、子代理 id 的短形式，日志与属性面板展示用 */
export const short = (id: string): string => id.slice(0, 8);

export const dbg = (tag: string, msg: string): void => console.log(`[${tag}] ${msg}`);
