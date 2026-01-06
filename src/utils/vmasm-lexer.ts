/**
 * VMASM Lexer - Token definitions for Chevrotain
 *
 * Ported from jsvmp-ir-extension for rc-devtools-mcp
 * Based on: skills/jsvmp-ir-parser.md
 */

import { createToken, Lexer } from 'chevrotain';

// ==========================================
// 基础 Tokens
// ==========================================

export const WhiteSpace = createToken({
  name: 'WhiteSpace',
  pattern: /[ \t]+/,
  group: Lexer.SKIPPED,
});

export const NewLine = createToken({
  name: 'NewLine',
  pattern: /\r?\n/,
});

export const LineComment = createToken({
  name: 'LineComment',
  // Match ; followed by content, but NOT when it looks like an assignment separator
  // (i.e., ; followed by whitespace, identifier, whitespace, equals, non-equals)
  // The [^=] ensures we don't exclude comments containing ===, ==, etc.
  pattern: /;(?!\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*=[^=])[^\n]*/,
  group: Lexer.SKIPPED,
  line_breaks: false,
});

// ==========================================
// 指令 Tokens
// ==========================================

export const FormatDirective = createToken({
  name: 'FormatDirective',
  pattern: /@format/,
});

export const DomainDirective = createToken({
  name: 'DomainDirective',
  pattern: /@domain/,
});

export const SourceDirective = createToken({
  name: 'SourceDirective',
  pattern: /@source/,
});

export const UrlDirective = createToken({
  name: 'UrlDirective',
  pattern: /@url/,
});

export const RegDirective = createToken({
  name: 'RegDirective',
  pattern: /@reg/,
});


export const SectionDirective = createToken({
  name: 'SectionDirective',
  pattern: /@section/,
});

export const ConstDirective = createToken({
  name: 'ConstDirective',
  pattern: /@const/,
});

export const EntryDirective = createToken({
  name: 'EntryDirective',
  pattern: /@entry/,
});

export const FuncDirective = createToken({
  name: 'FuncDirective',
  pattern: /@func/,
});

// 新增：注入点指令
export const DispatcherDirective = createToken({
  name: 'DispatcherDirective',
  pattern: /@dispatcher/,
});

// 新增：Scope Slot 指令
export const ScopeSlotDirective = createToken({
  name: 'ScopeSlotDirective',
  pattern: /@scope_slot/,
});

export const GlobalBytecodeDirective = createToken({
  name: 'GlobalBytecodeDirective',
  pattern: /@global_bytecode/,
});

export const LoopEntryDirective = createToken({
  name: 'LoopEntryDirective',
  pattern: /@loop_entry/,
});

export const FunctionEntryDirective = createToken({
  name: 'FunctionEntryDirective',
  pattern: /@function_entry/,
});

export const BreakpointDirective = createToken({
  name: 'BreakpointDirective',
  pattern: /@breakpoint/,
});

// 新增：Bytecode Transform 指令
export const BytecodeTransformDirective = createToken({
  name: 'BytecodeTransformDirective',
  pattern: /@bytecode_transform/,
});

// 新增：Opcode Transform 指令
export const OpcodeTransformDirective = createToken({
  name: 'OpcodeTransformDirective',
  pattern: /@opcode_transform/,
});

// Opcode Transform 整行匹配 - 把整行作为一个 token，避免解析复杂的 JS 表达式
// 格式: @opcode_transform {opcode} {NAME}: {expressions}
// 或: @opcode_transform {NAME}: {expressions} (opcode 可选，如 RETURN)
// 或: @opcode_transform -1 {NAME}: {expressions} (-1 作为默认/fallback)
// 表达式部分包含 <=, >=, ===, !==, &, |, ^, >>>, >>, <<, %, ~, !, typeof, instanceof, in 等
// 新格式支持引号包裹的表达式: "pre:varName = expression"; "post:result = expression"
export const OpcodeTransformLine = createToken({
  name: 'OpcodeTransformLine',
  pattern: /@opcode_transform\s+(?:-?\d+\s+)?[A-Z_]+:[^\n]*/,
  line_breaks: false,
});


// ==========================================
// 类型 Tokens
// ==========================================

export const TypeString = createToken({
  name: 'TypeString',
  pattern: /String/,
});

export const TypeNumber = createToken({
  name: 'TypeNumber',
  pattern: /Number/,
});

export const TypeBoolean = createToken({
  name: 'TypeBoolean',
  pattern: /Boolean/,
});

export const TypeNull = createToken({
  name: 'TypeNull',
  pattern: /Null/,
});

export const TypeObject = createToken({
  name: 'TypeObject',
  pattern: /Object/,
});

// ==========================================
// 地址与引用 Tokens
// ==========================================

export const HexAddress = createToken({
  name: 'HexAddress',
  pattern: /0[xX][0-9A-Fa-f]+:?/,
});

export const KRef = createToken({
  name: 'KRef',
  pattern: /K\[\d+\]/,
});

export const VRef = createToken({
  name: 'VRef',
  pattern: /v\[\d+\]/,
});

// ==========================================
// 字面量 Tokens
// ==========================================

export const QuotedString = createToken({
  name: 'QuotedString',
  // Support multi-line strings by using [\s\S] instead of [^\\"]
  // This matches any character including newlines
  pattern: /"(?:[^\\"\n]|\\.|\n)*"/,
  line_breaks: true, // Enable line break tracking for multi-line strings
});

export const NumericLiteral = createToken({
  name: 'NumericLiteral',
  pattern: /-?\d+(?:\.\d+)?/,
});

export const BooleanLiteral = createToken({
  name: 'BooleanLiteral',
  pattern: /true|false/,
});


// ==========================================
// 操作符 Tokens
// ==========================================

export const Equals = createToken({
  name: 'Equals',
  pattern: /=/,
});

export const Colon = createToken({
  name: 'Colon',
  pattern: /:/,
});

export const Comma = createToken({
  name: 'Comma',
  pattern: /,/,
});

export const LParen = createToken({
  name: 'LParen',
  pattern: /\(/,
});

export const RParen = createToken({
  name: 'RParen',
  pattern: /\)/,
});

export const LBracket = createToken({
  name: 'LBracket',
  pattern: /\[/,
});

export const RBracket = createToken({
  name: 'RBracket',
  pattern: /\]/,
});

// 新增：Semicolon 用于 opcode_transform 表达式分隔
// This token matches ; when it's used as an assignment separator
// (followed by whitespace and an identifier that will be assigned)
// The pattern ensures = is followed by a non-= character to avoid matching ===, ==, etc.
export const Semicolon = createToken({
  name: 'Semicolon',
  pattern: /;(?=\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*=[^=])/,
});

// 新增：算术运算符 tokens (用于 opcode_transform 表达式)
export const Plus = createToken({
  name: 'Plus',
  pattern: /\+/,
});

export const Minus = createToken({
  name: 'Minus',
  pattern: /-(?!\d)/, // Negative lookahead to not match negative numbers
});

export const Asterisk = createToken({
  name: 'Asterisk',
  pattern: /\*/,
});

export const Slash = createToken({
  name: 'Slash',
  pattern: /\//,
});

export const Dot = createToken({
  name: 'Dot',
  pattern: /\./,
});


// ==========================================
// 标识符（最后匹配）
// ==========================================

// URL value token - matches URL patterns like https://*.example.com/*/sample.js
// Must be placed before Identifier in token list to match first
export const UrlValue = createToken({
  name: 'UrlValue',
  pattern: /https?:\/\/[^\s]+/,
});

// Transform expression token - matches patterns like z.map(x=>x[0]) or z.map(x=>x.prop)
// This pattern matches: identifier(.identifier)*(arrow_function)?
// where arrow_function is (param=>param[index]) or (param=>param.prop)
// Must be placed before Identifier in token list to match first
export const TransformExpr = createToken({
  name: 'TransformExpr',
  pattern:
    /[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*\([a-zA-Z_$][a-zA-Z0-9_$]*=>[a-zA-Z_$][a-zA-Z0-9_$]*(?:\[\d+\]|\.[a-zA-Z_$][a-zA-Z0-9_$]*)\)/,
});

export const Identifier = createToken({
  name: 'Identifier',
  pattern: /[a-zA-Z_$][a-zA-Z0-9_$\-\.\/\*]*/,
});

// ==========================================
// Token 列表（顺序重要！）
// ==========================================

export const vmasmTokens = [
  // 跳过的 tokens (except LineComment which needs special ordering)
  WhiteSpace,
  NewLine,

  // Semicolon must come before LineComment to match assignment separators
  Semicolon, // 新增：用于 opcode_transform 表达式分隔

  // LineComment after Semicolon so ; followed by identifier is not treated as comment
  LineComment,

  // 指令 tokens（按长度排序，长的优先）
  // OpcodeTransformLine 必须在 OpcodeTransformDirective 之前，因为它匹配整行
  OpcodeTransformLine, // 新增：匹配整个 @opcode_transform 行
  BytecodeTransformDirective, // 新增：@bytecode_transform
  OpcodeTransformDirective, // 新增：@opcode_transform (fallback)
  GlobalBytecodeDirective,
  FunctionEntryDirective,
  LoopEntryDirective,
  BreakpointDirective,
  DispatcherDirective,
  ScopeSlotDirective, // 新增：@scope_slot
  FormatDirective,
  DomainDirective,
  SourceDirective,
  UrlDirective,
  RegDirective,
  SectionDirective,
  ConstDirective,
  EntryDirective,
  FuncDirective,

  // 类型 tokens
  TypeString,
  TypeNumber,
  TypeBoolean,
  TypeNull,
  TypeObject,

  // 地址与引用
  HexAddress,
  KRef,
  VRef,

  // 字面量
  QuotedString,
  BooleanLiteral,
  NumericLiteral,

  // 操作符
  Equals,
  Colon,
  Comma,
  Plus, // 新增：算术运算符
  Minus, // 新增：算术运算符
  Asterisk, // 新增：算术运算符
  Slash, // 新增：算术运算符
  Dot, // 新增：属性访问
  LParen,
  RParen,
  LBracket,
  RBracket,

  // URL value (before Identifier to match first)
  UrlValue,

  // Transform expression (before Identifier to match first)
  TransformExpr,

  // 标识符（最后）
  Identifier,
];

// 创建 Lexer 实例，启用行号追踪
export const VmasmLexer = new Lexer(vmasmTokens, {
  positionTracking: 'full', // 启用完整的位置追踪
});
