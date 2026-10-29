import { describe, it, expect } from 'vitest';
import { relativeTime } from '../src/renderer/features/resume/history';
import { sizeText } from '../src/renderer/features/resume/conversation-props';

describe('历史入口的时间与大小文本', () => {
  const now = new Date(2026, 9, 17, 15, 30).getTime();
  const min = 60_000;

  it('刚刚 / 分钟 / 小时 / 昨天 / 月-日', () => {
    expect(relativeTime(now - 20_000, now)).toBe('刚刚');
    expect(relativeTime(now - 5 * min, now)).toBe('5 分钟前');
    expect(relativeTime(now - 3 * 60 * min, now)).toBe('3 小时前');
    expect(relativeTime(new Date(2026, 9, 16, 23, 0).getTime(), now)).toBe('昨天');
    expect(relativeTime(new Date(2026, 9, 3, 9, 0).getTime(), now)).toBe('10-3');
  });

  it('跨过零点不足一天按昨天算', () => {
    const early = new Date(2026, 9, 17, 0, 40).getTime();
    expect(relativeTime(new Date(2026, 9, 16, 22, 0).getTime(), early)).toBe('昨天');
  });

  it('字节数换算', () => {
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(182 * 1024)).toBe('182 KB');
    expect(sizeText(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});
