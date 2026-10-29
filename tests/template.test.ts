import { describe, it, expect } from 'vitest';
import {
  contextValues, localDate, parseTemplateVars, renderTemplate, sanitizeTemplateInput, sortTemplates,
  templateSummary, userVars, TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX, type PromptTemplate,
} from '../src/shared/template';

describe('parseTemplateVars', () => {
  it('按首次出现顺序列出变量，同名只列一次，默认值取第一个写了默认值的位置', () => {
    const vars = parseTemplateVars('修 {{模块}} 的 {{问题:崩溃}}，再看 {{模块:core}} 与 {{问题:卡顿}}');
    expect(vars).toEqual([
      { name: '模块', builtin: false, kind: 'text', defaultValue: 'core' },
      { name: '问题', builtin: false, kind: 'text', defaultValue: '崩溃' },
    ]);
  });

  it('识别内置变量与文件变量，名称两侧空白忽略', () => {
    const vars = parseTemplateVars('{{ 分支 }} {{目录}} {{项目}} {{日期}} {{改动文件}} {{文件}} {{name_1}}');
    expect(vars.map(v => [v.name, v.builtin, v.kind])).toEqual([
      ['分支', true, 'text'], ['目录', true, 'text'], ['项目', true, 'text'], ['日期', true, 'text'],
      ['改动文件', true, 'text'], ['文件', false, 'file'], ['name_1', false, 'text'],
    ]);
    expect(userVars(vars).map(v => v.name)).toEqual(['文件', 'name_1']);
  });

  it('转义与不合规的写法不算变量', () => {
    expect(parseTemplateVars('\\{{字面}} {{a b}} {{未闭合 {{}}')).toEqual([]);
  });

  it('空默认值也算写了默认值', () => {
    expect(parseTemplateVars('{{备注:}}')[0]).toMatchObject({ name: '备注', defaultValue: '' });
  });
});

describe('renderTemplate', () => {
  it('取值替换，空白取值退回默认值', () => {
    const r = renderTemplate('改 {{文件}}，原因：{{原因:没写}}', { 文件: 'src/a.ts', 原因: '  ' });
    expect(r).toEqual({ text: '改 src/a.ts，原因：没写', missing: [] });
  });

  it('自定义变量既无取值也无默认值时列入 missing，只列一次', () => {
    const r = renderTemplate('{{甲}}-{{乙}}-{{甲}}', { 乙: 'x' });
    expect(r.missing).toEqual(['甲']);
    expect(r.text).toBe('-x-');
  });

  it('内置变量取不到时渲染为空串且不算缺失', () => {
    const r = renderTemplate('分支：{{分支}}', {});
    expect(r).toEqual({ text: '分支：', missing: [] });
  });

  it('\\{{ 输出字面的 {{，不合规写法原样保留', () => {
    const r = renderTemplate('\\{{x}} {{a b}} {{y}}', { y: '1' });
    expect(r.text).toBe('{{x}} {{a b}} 1');
  });

  it('多行正文与取值保持换行', () => {
    const r = renderTemplate('第一行\n{{内容}}\n末行', { 内容: 'a\nb' });
    expect(r.text).toBe('第一行\na\nb\n末行');
  });

  it('上下文转取值表', () => {
    const vals = contextValues({ 日期: '2026-10-17', 分支: 'main', 项目: 'p' });
    expect(renderTemplate('{{项目}}@{{分支}} {{日期}} {{目录}}', vals).text).toBe('p@main 2026-10-17 ');
    expect(contextValues(null)).toEqual({});
  });
});

describe('辅助函数', () => {
  it('localDate 为本地 yyyy-MM-dd', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
  });

  it('templateSummary 压平空白并截断', () => {
    expect(templateSummary('a\n\n  b\tc')).toBe('a b c');
    expect(templateSummary('x'.repeat(70), 60)).toBe(`${'x'.repeat(60)}…`);
  });

  it('sanitizeTemplateInput 校验并规范化', () => {
    expect(sanitizeTemplateInput(null)).toEqual({ ok: false, error: '参数无效' });
    expect(sanitizeTemplateInput({ name: ' ', body: 'x' })).toMatchObject({ ok: false });
    expect(sanitizeTemplateInput({ name: 'n', body: '  \n ' })).toMatchObject({ ok: false });
    expect(sanitizeTemplateInput({ name: 'n'.repeat(TEMPLATE_NAME_MAX + 1), body: 'x' })).toMatchObject({ ok: false });
    expect(sanitizeTemplateInput({ name: 'n', body: 'x'.repeat(TEMPLATE_BODY_MAX + 1) })).toMatchObject({ ok: false });
    expect(sanitizeTemplateInput({ id: 'i', name: ' 名 ', body: 'a\r\nb\rc', description: ' ' })).toEqual({
      ok: true, value: { id: 'i', name: '名', body: 'a\nb\nc' },
    });
  });

  it('sortTemplates 最近使用在前，未使用的按更新时间倒序', () => {
    const t = (id: string, updatedAt: number, lastUsedAt?: number): PromptTemplate =>
      ({ id, name: id, body: 'b', createdAt: 0, updatedAt, lastUsedAt, useCount: 0 });
    const sorted = sortTemplates([t('a', 1), t('b', 5), t('c', 0, 10), t('d', 0, 20)]);
    expect(sorted.map(x => x.id)).toEqual(['d', 'c', 'b', 'a']);
  });
});
