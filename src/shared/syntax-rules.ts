/**
 * 语法分词的各语言规则表：关键字、内置类型与代码类语言的词法开关。
 * 只是数据，扫描逻辑在 syntax-tokenize 与 syntax-markup 中。
 */

export interface CodeSpec {
  /** 行注释起始符，如 // # -- */
  lineCom: string[];
  /** 行注释只在行首或空白之后才算（scss 的 // 与 url(http://) 区分） */
  lineComAfterSpace?: boolean;
  /** 块注释起止符 */
  blockCom?: [string, string];
  /** 单行字符串的引号字符 */
  quotes: string;
  /** 可跨行的引号，如 Python 与 Java 的三引号 */
  multiQuotes: string[];
  /** js 族：反引号模板字符串与 ${} 嵌套、正则字面量 */
  template?: boolean;
  /** 字符串后紧跟冒号时按属性名着色（json 的键） */
  keyStrings?: boolean;
  /** @标识符 按 meta 着色（注解、装饰器） */
  annotation?: boolean;
  /** 关键字不区分大小写（sql） */
  caseInsensitive?: boolean;
  /** 首字母大写且含小写字母的标识符按类型着色 */
  capType?: boolean;
  /** css 族：标识符可含连字符，按花括号深度区分选择器与属性 */
  css?: boolean;
  keywords: Set<string>;
  types: Set<string>;
}

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS_KW = words(`
  break case catch class const continue debugger default delete do else export extends finally for
  function if import in instanceof let new of return super switch this throw try typeof var void while
  with yield async await static from as type interface enum implements private protected public readonly
  abstract declare namespace module keyof infer is satisfies override accessor true false null undefined
`);

const JS_TYPES = words(`
  string number boolean any unknown never object symbol bigint
  Promise Array Record Partial Required Readonly Map Set Date Error RegExp
`);

const JAVA_KW = words(`
  abstract assert break case catch class const continue default do else enum extends final finally for
  goto if implements import instanceof interface native new package private protected public return
  static strictfp super switch synchronized this throw throws transient try volatile while var record
  sealed permits yield true false null
`);

const JAVA_TYPES = words('boolean byte char double float int long short void String Object Integer Long List Map');

const PY_KW = words(`
  and as assert async await break class continue def del elif else except finally for from global if
  import in is lambda nonlocal not or pass raise return try while with yield match case True False None self
`);

const PY_TYPES = words('int float str bool bytes list dict set tuple object type complex frozenset');

const SQL_KW = words(`
  select from where and or not insert into values update set delete create table alter drop index view
  primary key foreign references unique null default join left right inner outer full cross on as
  group by order having limit offset union all distinct case when then else end exists in between like
  is asc desc if begin commit rollback transaction with recursive returning constraint check cascade
  truncate grant revoke database schema column add modify rename to comment engine charset auto_increment
  true false
`);

const SQL_TYPES = words(`
  int integer bigint smallint tinyint decimal numeric float double real char varchar text longtext
  date datetime timestamp time boolean bool blob json jsonb uuid serial bigserial bit
`);

const CSS_KW = words('important inherit initial unset none auto');

const JSON_KW = words('true false null');

export const JS_SPEC: CodeSpec = {
  lineCom: ['//'], blockCom: ['/*', '*/'], quotes: `"'`, multiQuotes: [], template: true,
  annotation: true, capType: true, keywords: JS_KW, types: JS_TYPES,
};

export const JAVA_SPEC: CodeSpec = {
  lineCom: ['//'], blockCom: ['/*', '*/'], quotes: `"'`, multiQuotes: ['"""'],
  annotation: true, capType: true, keywords: JAVA_KW, types: JAVA_TYPES,
};

export const PY_SPEC: CodeSpec = {
  lineCom: ['#'], quotes: `"'`, multiQuotes: ['"""', "'''"],
  annotation: true, capType: true, keywords: PY_KW, types: PY_TYPES,
};

export const SQL_SPEC: CodeSpec = {
  lineCom: ['--'], blockCom: ['/*', '*/'], quotes: `'"\``, multiQuotes: [],
  caseInsensitive: true, keywords: SQL_KW, types: SQL_TYPES,
};

export const CSS_SPEC: CodeSpec = {
  lineCom: ['//'], lineComAfterSpace: true, blockCom: ['/*', '*/'], quotes: `"'`, multiQuotes: [],
  css: true, keywords: CSS_KW, types: new Set(),
};

export const JSON_SPEC: CodeSpec = {
  lineCom: ['//'], blockCom: ['/*', '*/'], quotes: '"', multiQuotes: [],
  keyStrings: true, keywords: JSON_KW, types: new Set(),
};
