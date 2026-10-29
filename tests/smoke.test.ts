import { describe, it, expect } from 'vitest';

describe('脚手架', () => {
  it('vitest 可运行', () => {
    expect(1 + 1).toBe(2);
  });

  it('Node + TS 集成可用', () => {
    const path = require('path');
    expect(path.join('a', 'b')).toBe(path.sep === '/' ? 'a/b' : 'a\\b');
  });
});