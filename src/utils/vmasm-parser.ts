/**
 * VMASM Parser - Chevrotain-based parser for .vmasm files
 *
 * Ported from jsvmp-ir-extension for rc-devtools-mcp
 * Based on: skills/jsvmp-ir-parser.md
 */

import { CstParser } from 'chevrotain';
import {
  vmasmTokens,
  NewLine,
  FormatDirective,
  DomainDirective,
  SourceDirective,
  UrlDirective,
  RegDirective,
  SectionDirective,
  ConstDirective,
  EntryDirective,
  FuncDirective,
  DispatcherDirective,
  GlobalBytecodeDirective,
  BytecodeTransformDirective,
  OpcodeTransformLine,
  LoopEntryDirective,
  FunctionEntryDirective,
  BreakpointDirective,
  ScopeSlotDirective,
  TypeString,
  TypeNumber,
  TypeBoolean,
  TypeNull,
  TypeObject,
  HexAddress,
  KRef,
  VRef,
  QuotedString,
  NumericLiteral,
  BooleanLiteral,
  Equals,
  Colon,
  Comma,
  LParen,
  RParen,
  UrlValue,
  Identifier,
  TransformExpr,
} from './vmasm-lexer.js';

/**
 * VMASM CST Parser
 */
export class VmasmParser extends CstParser {
  constructor() {
    super(vmasmTokens, {
      // Enable error recovery to continue parsing after errors
      recoveryEnabled: true,
    });
    this.performSelfAnalysis();
  }


  // ==========================================
  // 顶层规则
  // ==========================================

  public program = this.RULE('program', () => {
    this.MANY(() => {
      this.OR([
        { ALT: () => this.SUBRULE(this.formatDecl) },
        { ALT: () => this.SUBRULE(this.domainDecl) },
        { ALT: () => this.SUBRULE(this.sourceDecl) },
        { ALT: () => this.SUBRULE(this.urlDecl) },
        { ALT: () => this.SUBRULE(this.regDecl) },
        { ALT: () => this.SUBRULE(this.dispatcherDecl) },
        { ALT: () => this.SUBRULE(this.globalBytecodeDecl) },
        { ALT: () => this.SUBRULE(this.bytecodeTransformDecl) },
        { ALT: () => this.SUBRULE(this.opcodeTransformDecl) },
        { ALT: () => this.SUBRULE(this.loopEntryDecl) },
        { ALT: () => this.SUBRULE(this.functionEntryDecl) },
        { ALT: () => this.SUBRULE(this.breakpointDecl) },
        { ALT: () => this.SUBRULE(this.scopeSlotDecl) },
        { ALT: () => this.SUBRULE(this.sectionDecl) },
        { ALT: () => this.SUBRULE(this.constDecl) },
        { ALT: () => this.SUBRULE(this.entryDecl) },
        { ALT: () => this.SUBRULE(this.funcDecl) },
        { ALT: () => this.SUBRULE(this.instruction) },
        { ALT: () => this.CONSUME(NewLine) },
      ]);
    });
  });

  // ==========================================
  // Header 指令
  // ==========================================

  private formatDecl = this.RULE('formatDecl', () => {
    this.CONSUME(FormatDirective);
    this.CONSUME(Identifier);
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private domainDecl = this.RULE('domainDecl', () => {
    this.CONSUME(DomainDirective);
    this.CONSUME(Identifier);
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private sourceDecl = this.RULE('sourceDecl', () => {
    this.CONSUME(SourceDirective);
    this.CONSUME(Identifier);
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private urlDecl = this.RULE('urlDecl', () => {
    this.CONSUME(UrlDirective);
    this.OR([{ ALT: () => this.CONSUME(UrlValue) }, { ALT: () => this.CONSUME(Identifier) }]);
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private regDecl = this.RULE('regDecl', () => {
    this.CONSUME(RegDirective);
    this.AT_LEAST_ONE_SEP({
      SEP: Comma,
      DEF: () => this.SUBRULE(this.regMapping),
    });
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private regMapping = this.RULE('regMapping', () => {
    this.CONSUME(Identifier);
    this.CONSUME(Equals);
    this.CONSUME2(Identifier);
  });


  // ==========================================
  // 注入点指令
  // ==========================================

  private dispatcherDecl = this.RULE('dispatcherDecl', () => {
    this.CONSUME(DispatcherDirective);
    this.AT_LEAST_ONE_SEP({
      SEP: Comma,
      DEF: () => this.SUBRULE(this.locationMapping),
    });
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private globalBytecodeDecl = this.RULE('globalBytecodeDecl', () => {
    this.CONSUME(GlobalBytecodeDirective);
    this.AT_LEAST_ONE_SEP({
      SEP: Comma,
      DEF: () => this.SUBRULE2(this.locationMapping),
    });
    this.OPTION(() => this.CONSUME(NewLine));
  });

  /**
   * Parse @bytecode_transform directive
   * Format: @bytecode_transform expr="z.map(x=>x[0])"
   */
  private bytecodeTransformDecl = this.RULE('bytecodeTransformDecl', () => {
    this.CONSUME(BytecodeTransformDirective);
    this.AT_LEAST_ONE_SEP({
      SEP: Comma,
      DEF: () => this.SUBRULE(this.transformMapping),
    });
    this.OPTION(() => this.CONSUME(NewLine));
  });

  /**
   * Parse transform mapping: expr="..."
   */
  private transformMapping = this.RULE('transformMapping', () => {
    this.CONSUME(Identifier); // key: expr
    this.CONSUME(Equals);
    this.OR([
      { ALT: () => this.CONSUME(QuotedString) }, // "z.map(x=>x[0])"
      { ALT: () => this.CONSUME(TransformExpr) }, // z.map(x=>x[0]) without quotes
      { ALT: () => this.CONSUME2(Identifier) }, // simple identifier
    ]);
  });

  /**
   * Parse @opcode_transform directive - 整行作为一个 token
   * Format: @opcode_transform <number> <name>: <expressions>
   * Example: @opcode_transform 68 ADD: a = v[p - 1]; b = v[p]; result = a + b
   *
   * 表达式部分在 visitor 中解析，这里只消费整行 token
   */
  private opcodeTransformDecl = this.RULE('opcodeTransformDecl', () => {
    this.CONSUME(OpcodeTransformLine);
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private loopEntryDecl = this.RULE('loopEntryDecl', () => {
    this.CONSUME(LoopEntryDirective);
    this.AT_LEAST_ONE_SEP({
      SEP: Comma,
      DEF: () => this.SUBRULE3(this.locationMapping),
    });
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private functionEntryDecl = this.RULE('functionEntryDecl', () => {
    this.CONSUME(FunctionEntryDirective);
    this.AT_LEAST_ONE_SEP({
      SEP: Comma,
      DEF: () => this.SUBRULE5(this.locationMapping),
    });
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private breakpointDecl = this.RULE('breakpointDecl', () => {
    this.CONSUME(BreakpointDirective);
    this.AT_LEAST_ONE_SEP({
      SEP: Comma,
      DEF: () => this.SUBRULE4(this.locationMapping),
    });
    this.OPTION(() => this.CONSUME(NewLine));
  });


  // ==========================================
  // Scope Slot 指令
  // ==========================================

  /**
   * Parse @scope_slot directive
   * Format: @scope_slot depth=N, index=M, name="X", first_use="..."
   * Optional fields: source_line, source_column
   */
  private scopeSlotDecl = this.RULE('scopeSlotDecl', () => {
    this.CONSUME(ScopeSlotDirective);
    this.AT_LEAST_ONE_SEP({
      SEP: Comma,
      DEF: () => this.SUBRULE(this.scopeSlotMapping),
    });
    this.OPTION(() => this.CONSUME(NewLine));
  });

  /**
   * Parse individual key=value mappings in @scope_slot
   * Keys: depth, index, name, first_use, source_line, source_column
   */
  private scopeSlotMapping = this.RULE('scopeSlotMapping', () => {
    this.CONSUME(Identifier); // key: depth, index, name, first_use, source_line, source_column
    this.CONSUME(Equals);
    this.OR([
      { ALT: () => this.CONSUME(NumericLiteral) },
      { ALT: () => this.CONSUME(QuotedString) },
      { ALT: () => this.CONSUME2(Identifier) },
    ]);
  });

  private locationMapping = this.RULE('locationMapping', () => {
    this.CONSUME(Identifier); // key: line, column, var, name, pattern, transform
    this.CONSUME(Equals);
    this.OR([
      {
        // Handle values like "2d_array" which get tokenized as NumericLiteral + Identifier
        ALT: () => {
          this.CONSUME(NumericLiteral);
          this.OPTION(() => this.CONSUME2(Identifier));
        },
      },
      // Handle quoted strings like "2d_array" or "z.map(x=>x[0])"
      { ALT: () => this.CONSUME(QuotedString) },
      // Handle transform expressions like z.map(x=>x[0])
      { ALT: () => this.CONSUME(TransformExpr) },
      { ALT: () => this.CONSUME3(Identifier) },
    ]);
  });


  // ==========================================
  // Section 指令
  // ==========================================

  private sectionDecl = this.RULE('sectionDecl', () => {
    this.CONSUME(SectionDirective);
    this.CONSUME(Identifier);
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private constDecl = this.RULE('constDecl', () => {
    this.CONSUME(ConstDirective);
    this.CONSUME(KRef);
    this.CONSUME(Equals);
    this.SUBRULE(this.typedValue);
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private typedValue = this.RULE('typedValue', () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(TypeString);
          this.CONSUME(LParen);
          this.CONSUME(QuotedString);
          this.CONSUME(RParen);
        },
      },
      {
        ALT: () => {
          this.CONSUME(TypeNumber);
          this.CONSUME2(LParen);
          this.CONSUME(NumericLiteral);
          this.CONSUME2(RParen);
        },
      },
      {
        ALT: () => {
          this.CONSUME(TypeBoolean);
          this.CONSUME3(LParen);
          this.CONSUME(BooleanLiteral);
          this.CONSUME3(RParen);
        },
      },
      { ALT: () => this.CONSUME(TypeNull) },
      {
        ALT: () => {
          this.CONSUME(TypeObject);
          this.CONSUME4(LParen);
          this.CONSUME2(QuotedString);
          this.CONSUME4(RParen);
        },
      },
    ]);
  });


  // ==========================================
  // Code 指令
  // ==========================================

  private entryDecl = this.RULE('entryDecl', () => {
    this.CONSUME(EntryDirective);
    this.CONSUME(HexAddress);
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private funcDecl = this.RULE('funcDecl', () => {
    this.CONSUME(FuncDirective);
    this.CONSUME(Identifier);
    this.OPTION(() => this.CONSUME(NewLine));
  });

  private instruction = this.RULE('instruction', () => {
    this.CONSUME(HexAddress);
    // Handle optional colon after address (for formats like "0x0000 : OPCODE")
    this.OPTION1(() => this.CONSUME(Colon));
    this.CONSUME(Identifier); // opcode
    this.MANY(() => this.SUBRULE(this.operand));
    this.OPTION2(() => this.CONSUME(NewLine));
  });

  private operand = this.RULE('operand', () => {
    this.OR([
      { ALT: () => this.CONSUME(KRef) },
      { ALT: () => this.CONSUME(VRef) },
      { ALT: () => this.CONSUME(HexAddress) },
      { ALT: () => this.CONSUME(NumericLiteral) },
      { ALT: () => this.CONSUME(QuotedString) },
      { ALT: () => this.CONSUME(Identifier) },
    ]);
  });
}

// 创建 Parser 单例
export const vmasmParser = new VmasmParser();
