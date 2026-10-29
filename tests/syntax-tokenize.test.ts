import { describe, expect, it } from 'vitest';
import {
  INITIAL_STATE, MAX_HIGHLIGHT_LINE, hunkTokenizer, langOf, tokenizeHunk, tokenizeLine, type Lang, type LexState, type Token,
} from '../src/shared/syntax-tokenize';
import type { DiffLine } from '../src/shared/types';

/** 区间转成 [类别, 文本] 便于断言 */
function pieces(text: string, tokens: Token[]): Array<[string, string]> {
  return tokens.map(t => [t.k, text.slice(t.s, t.e)]);
}

function lex(lang: Lang, text: string, st: LexState = INITIAL_STATE): { p: Array<[string, string]>; state: LexState; tokens: Token[] } {
  const r = tokenizeLine(lang, text, st);
  return { p: pieces(text, r.tokens), state: r.state, tokens: r.tokens };
}

/** 多行连续分词，返回每行的片段 */
function lexLines(lang: Lang, lines: string[]): Array<Array<[string, string]>> {
  let st = INITIAL_STATE;
  return lines.map(l => {
    const r = tokenizeLine(lang, l, st);
    st = r.state;
    return pieces(l, r.tokens);
  });
}

function assertWellFormed(text: string, tokens: Token[]): void {
  let prev = 0;
  for (const t of tokens) {
    expect(t.s).toBeGreaterThanOrEqual(prev);
    expect(t.e).toBeGreaterThan(t.s);
    expect(t.e).toBeLessThanOrEqual(text.length);
    prev = t.e;
  }
}

describe('langOf 扩展名映射', () => {
  it('识别各语言族', () => {
    const cases: Array<[string, Lang]> = [
      ['a.ts', 'js'], ['a.tsx', 'js'], ['a.mts', 'js'], ['a.cts', 'js'], ['b.js', 'js'], ['b.jsx', 'js'],
      ['b.mjs', 'js'], ['b.cjs', 'js'], ['src/X.java', 'java'], ['m.py', 'py'], ['App.vue', 'vue'],
      ['p.json', 'json'], ['tsconfig.jsonc', 'json'], ['q.sql', 'sql'], ['s.css', 'css'], ['s.scss', 'css'],
      ['s.less', 'css'], ['README.md', 'md'], ['C:\\w\\index.HTML', 'markup'], ['.eslintrc.json', 'json'],
    ];
    for (const [p, l] of cases) expect(langOf(p), p).toBe(l);
  });

  it('未识别的扩展名返回 undefined，不报错', () => {
    expect(langOf('Makefile')).toBeUndefined();
    expect(langOf('a.unknownext')).toBeUndefined();
    expect(langOf('.gitignore')).toBeUndefined();
    expect(langOf('')).toBeUndefined();
  });
});

describe('js / ts 分词', () => {
  it('关键字、字符串、数字、注释、类型与函数名', () => {
    const { p } = lex('js', 'const n: number = parseInt("42", 10); // 注释');
    expect(p).toEqual([
      ['kw', 'const'], ['type', 'number'], ['fn', 'parseInt'], ['str', '"42"'], ['num', '10'], ['com', '// 注释'],
    ]);
  });

  it('首字母大写为类型，成员访问不当关键字', () => {
    const { p } = lex('js', 'new UserService().delete(x.default)');
    expect(p).toEqual([['kw', 'new'], ['fn', 'UserService'], ['fn', 'delete']]);
    expect(lex('js', 'let m: Map<string, User>').p).toEqual([
      ['kw', 'let'], ['type', 'Map'], ['type', 'string'], ['type', 'User'],
    ]);
  });

  it('块注释跨多行时后续行延续注释色', () => {
    const rows = lexLines('js', ['a = 1; /* 开始', '中间 const', '结束 */ let b']);
    expect(rows[0]).toEqual([['num', '1'], ['com', '/* 开始']]);
    expect(rows[1]).toEqual([['com', '中间 const']]);
    expect(rows[2]).toEqual([['com', '结束 */'], ['kw', 'let']]);
  });

  it('模板字符串跨行与 ${} 嵌套', () => {
    const rows = lexLines('js', ['const s = `a ${x + `in${y}`} b', 'still text', 'end` + 1']);
    expect(rows[0]).toEqual([
      ['kw', 'const'], ['str', '`a '], ['punct', '${'], ['str', '`in'], ['punct', '${'], ['punct', '}'],
      ['str', '`'], ['punct', '}'], ['str', ' b'],
    ]);
    expect(rows[1]).toEqual([['str', 'still text']]);
    expect(rows[2]).toEqual([['str', 'end`'], ['num', '1']]);
  });

  it('模板表达式内的对象花括号不提前结束表达式', () => {
    const { p, state } = lex('js', 'x = `${ {a: 1}.a }` + "q"');
    expect(p).toEqual([['str', '`'], ['punct', '${'], ['num', '1'], ['punct', '}'], ['str', '`'], ['str', '"q"']]);
    expect(state).toEqual({ mode: 'code' });
  });

  it('正则字面量与除号区分', () => {
    expect(lex('js', 'const r = /a"b/g;').p).toEqual([['kw', 'const'], ['str', '/a"b/g']]);
    expect(lex('js', 'const q = a / b / c;').p).toEqual([['kw', 'const']]);
  });

  it('装饰器按 meta 着色', () => {
    expect(lex('js', '@Component({})').p[0]).toEqual(['meta', '@Component']);
  });
});

describe('java / python / sql', () => {
  it('java 注解、关键字与基本类型', () => {
    expect(lex('java', '@Override public int size() { return 0; }').p).toEqual([
      ['meta', '@Override'], ['kw', 'public'], ['type', 'int'], ['fn', 'size'], ['kw', 'return'], ['num', '0'],
    ]);
  });

  it('python 三引号跨行，# 注释', () => {
    const rows = lexLines('py', ['def f():  # 说明', '    s = """第一行', '    第二行 def', '    """ + x']);
    expect(rows[0]).toEqual([['kw', 'def'], ['fn', 'f'], ['com', '# 说明']]);
    expect(rows[1]).toEqual([['str', '"""第一行']]);
    expect(rows[2]).toEqual([['str', '    第二行 def']]);
    expect(rows[3]).toEqual([['str', '    """']]);
  });

  it('python 单行三引号不进入跨行状态', () => {
    const r = lex('py', "x = '''abc''' if True else None");
    expect(r.state).toEqual({ mode: 'code' });
    expect(r.p).toEqual([['str', "'''abc'''"], ['kw', 'if'], ['kw', 'True'], ['kw', 'else'], ['kw', 'None']]);
  });

  it('sql 关键字不区分大小写，块注释跨行', () => {
    expect(lex('sql', "SELECT id FROM t WHERE name = 'a' -- 注释").p).toEqual([
      ['kw', 'SELECT'], ['kw', 'FROM'], ['kw', 'WHERE'], ['str', "'a'"], ['com', '-- 注释'],
    ]);
    const rows = lexLines('sql', ['/* 多行', 'select */ insert']);
    expect(rows[1]).toEqual([['com', 'select */'], ['kw', 'insert']]);
  });
});

describe('json / css', () => {
  it('json 键按属性着色，值按字符串、数字与字面量', () => {
    expect(lex('json', '  "name": "nexus", "n": 1.5e3, "ok": true, "x": null').p).toEqual([
      ['prop', '"name"'], ['str', '"nexus"'], ['prop', '"n"'], ['num', '1.5e3'], ['prop', '"ok"'], ['kw', 'true'],
      ['prop', '"x"'], ['kw', 'null'],
    ]);
  });

  it('css 选择器、属性、颜色与单位，花括号深度跨行', () => {
    const rows = lexLines('css', ['.btn > a {', '  color: #fff;', '  margin: 4px 0 !important;', '}', 'p {}']);
    expect(rows[0]).toEqual([['attr', '.btn'], ['tag', 'a']]);
    expect(rows[1]).toEqual([['prop', 'color'], ['num', '#fff']]);
    expect(rows[2]).toEqual([['prop', 'margin'], ['num', '4px'], ['num', '0'], ['kw', '!important']]);
    expect(rows[4]).toEqual([['tag', 'p']]);
  });

  it('scss 的 // 注释与 url 中的 // 区分', () => {
    expect(lex('css', '  // 注释').p).toEqual([['com', '// 注释']]);
    const r = lex('css', 'a { background: url(http://x/y.png) }');
    expect(r.p.some(([k]) => k === 'com')).toBe(false);
  });
});

describe('标记语言 / vue / markdown', () => {
  it('标签、属性名与属性值，注释跨行', () => {
    const rows = lexLines('markup', ['<div class="a" id=b>文本<!-- 注', '释 --></div>']);
    expect(rows[0]).toEqual([
      ['punct', '<'], ['tag', 'div'], ['attr', 'class'], ['str', '"a"'], ['attr', 'id'], ['str', 'b'], ['punct', '>'],
      ['com', '<!-- 注'],
    ]);
    expect(rows[1]).toEqual([['com', '释 -->'], ['punct', '</'], ['tag', 'div'], ['punct', '>']]);
  });

  it('标签属性跨行时下一行仍按属性着色', () => {
    const rows = lexLines('markup', ['<input', '  type="text" />']);
    expect(rows[1]).toEqual([['attr', 'type'], ['str', '"text"'], ['punct', '/>']]);
  });

  it('vue 按 script / style 段切换内嵌语言', () => {
    const rows = lexLines('vue', [
      '<template><div>{{ msg }}</div></template>',
      '<script setup lang="ts">',
      'const msg: string = "hi" /* 跨',
      '行 */',
      '</script>',
      '<style scoped>.a { color: red }</style>',
      '<p>const</p>',
    ]);
    expect(rows[0][1]).toEqual(['tag', 'template']);
    expect(rows[2]).toEqual([['kw', 'const'], ['type', 'string'], ['str', '"hi"'], ['com', '/* 跨']]);
    expect(rows[3]).toEqual([['com', '行 */']]);
    expect(rows[4]).toEqual([['punct', '</'], ['tag', 'script'], ['punct', '>']]);
    expect(rows[5]).toEqual([
      ['punct', '<'], ['tag', 'style'], ['attr', 'scoped'], ['punct', '>'], ['attr', '.a'], ['prop', 'color'],
      ['punct', '</'], ['tag', 'style'], ['punct', '>'],
    ]);
    expect(rows[6]).toEqual([['punct', '<'], ['tag', 'p'], ['punct', '>'], ['punct', '</'], ['tag', 'p'], ['punct', '>']]);
  });

  it('markdown 标题、列表符、行内代码、链接与代码围栏', () => {
    const rows = lexLines('md', ['# 标题', '- 列表 `code` 和 [链接](http://a)', '```ts', 'const x = 1 // 不细分', '```', '正文']);
    expect(rows[0]).toEqual([['head', '# 标题']]);
    expect(rows[1]).toEqual([['punct', '-'], ['code', '`code`'], ['link', '[链接](http://a)']]);
    expect(rows[2]).toEqual([['meta', '```ts']]);
    expect(rows[3]).toEqual([['code', 'const x = 1 // 不细分']]);
    expect(rows[4]).toEqual([['meta', '```']]);
    expect(rows[5]).toEqual([]);
  });
});

describe('边界', () => {
  it('超长行不着色，但状态照常推进', () => {
    const long = '/* ' + 'x'.repeat(MAX_HIGHLIGHT_LINE);
    const r = tokenizeLine('js', long, INITIAL_STATE);
    expect(r.tokens).toEqual([]);
    expect(r.state.mode).toBe('com');
    expect(tokenizeLine('js', 'a */ const', r.state).tokens.map(t => t.k)).toEqual(['com', 'kw']);
  });

  it('各语言样例的区间升序、不重叠、不越界', () => {
    const samples: Array<[Lang, string]> = [
      ['js', 'export async function f<T>(a: T[] = [], b = `x${a}`) { return /re/g.test(a) ? 0x1F : 1_000n; }'],
      ['java', 'public record P(String name) implements Comparable<P> { /* c */ }'],
      ['py', '@dataclass class A(Base): x: int = 0'],
      ['json', '{"a": [1, 2, {"b": "c\\"d"}]}'],
      ['sql', "CREATE TABLE t (id BIGINT PRIMARY KEY, name VARCHAR(20) DEFAULT 'x');"],
      ['css', '@media (max-width: 640px) { .a::before { content: "→"; } }'],
      ['vue', '<script>export default { name: "x" }</script><style>a{}</style>'],
      ['md', '> - [ ] 任务 `a` **粗体** ![图](x.png)'],
      ['markup', '<?xml version="1.0"?><!DOCTYPE html><a href=\'x\'>&amp;</a>'],
    ];
    for (const [lang, text] of samples) {
      const r = tokenizeLine(lang, text, INITIAL_STATE);
      assertWellFormed(text, r.tokens);
    }
  });

  it('未闭合的单行字符串只到行尾，不影响下一行', () => {
    const r = lex('js', 'const s = "abc');
    expect(r.p).toEqual([['kw', 'const'], ['str', '"abc']]);
    expect(r.state).toEqual({ mode: 'code' });
  });
});

describe('tokenizeHunk 双流分词', () => {
  const L = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text });

  it('删除行的未闭合注释不污染新增行', () => {
    const lines = [L('del', 'a = 1; /* 旧注释'), L('add', 'let b = 2;'), L('del', '旧注释结束 */'), L('ctx', 'const c = 3;')];
    const t = tokenizeHunk('js', lines);
    expect(t[0].new).toBeUndefined();
    expect(t[1].old).toBeUndefined();
    expect(pieces('let b = 2;', t[1].new ?? [])).toEqual([['kw', 'let'], ['num', '2']]);
    expect(pieces('旧注释结束 */', t[2].old ?? [])).toEqual([['com', '旧注释结束 */']]);
    expect(pieces('const c = 3;', t[3].old ?? [])).toEqual([['kw', 'const'], ['num', '3']]);
    expect(pieces('const c = 3;', t[3].new ?? [])).toEqual([['kw', 'const'], ['num', '3']]);
  });

  it('上下文行在两条流状态不同时分别分词', () => {
    const lines = [L('add', '/* 新增的注释开头'), L('ctx', 'const x = 1; */')];
    const t = tokenizeHunk('js', lines);
    expect(pieces('const x = 1; */', t[1].old ?? []).map(p => p[0])).toEqual(['kw', 'num']);
    expect(pieces('const x = 1; */', t[1].new ?? [])).toEqual([['com', 'const x = 1; */']]);
  });

  it('元信息行没有区间，行尾回车不计入', () => {
    const t = tokenizeHunk('js', [L('add', 'let a\r'), L('meta', 'No newline at end of file')]);
    expect(t[1]).toEqual({});
    expect(t[0].new?.every(x => x.e <= 'let a'.length)).toBe(true);
  });

  it('每个分块从初始状态开始，块注释不跨分块', () => {
    const h1 = tokenizeHunk('js', [L('ctx', '/* 未闭合')]);
    const h2 = tokenizeHunk('js', [L('ctx', 'const a = 1;')]);
    expect(h1[0].new?.[0].k).toBe('com');
    expect(h2[0].new?.[0].k).toBe('kw');
  });

  it('按需推进与一次分完结果一致，越界返回空', () => {
    const lines = [L('ctx', '/* a'), L('del', 'b */ let x'), L('add', 'c */ const y'), L('ctx', 'var z = 1;')];
    const all = tokenizeHunk('js', lines);
    const lazy = hunkTokenizer('js', lines);
    expect(lazy.at(3)).toEqual(all[3]);
    expect(lazy.at(1)).toEqual(all[1]);
    expect(lazy.at(9)).toEqual({});
  });
});
