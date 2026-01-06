/**
 * VMASM AST Visitor - Extracts structured data from CST
 *
 * Ported from jsvmp-ir-extension for rc-devtools-mcp
 * Based on: skills/jsvmp-ir-parser.md
 */

import { vmasmParser } from './vmasm-parser.js';
import { splitQuotedExpressions, parseQuotedExpression, isQuotedFormat } from './transform-parser.js';

// ==========================================
// AST 类型定义
// ==========================================

export interface SourceLocation {
  line: number;
  column: number;
}

export interface RegisterMapping {
  ip: string;
  sp: string;
  stack: string;
  bc: string;
  storage: string;
  const: string;
  scope?: string;
}

export interface DispatcherInfo {
  location: SourceLocation;
  breakpoint?: SourceLocation;
}

export interface GlobalBytecodeInfo {
  variable: string;
  location: SourceLocation;
  pattern: '2d_array' | '1d_slice';
  localVariable?: string;
  transform?: string; // Transform expression for extracting raw bytecode
}

export interface LoopEntryInfo {
  location: SourceLocation;
}

export interface ConstantEntry {
  index: number;
  type: 'String' | 'Number' | 'Boolean' | 'Null' | 'Object';
  value: string | number | boolean | null;
}

export interface InstructionEntry {
  addr: number;
  opcode: string;
  operands: string[];
  lineNumber: number;
}


/**
 * Scope slot entry - maps a scope slot to its original variable name
 * Used for @scope_slot directives
 */
export interface ScopeSlotEntry {
  depth: number; // Scope chain depth (0 = current, 1 = parent, etc.)
  index: number; // Slot index within scope
  name: string; // Variable name or "?" if unknown
  firstUse?: string; // First instruction using this slot
  sourceLine?: number;
  sourceColumn?: number;
}

/**
 * Single variable assignment in an opcode transform
 * Used for @opcode_transform directives
 */
export interface TransformVariable {
  name: string; // Variable name (e.g., "a", "result")
  expression: string; // JS expression (e.g., "v[p - 1]")
  isPost?: boolean; // Whether this is a post-execution expression (default: false)
}

/**
 * Complete opcode transform definition
 * Maps an opcode number to a set of expressions that compute runtime values
 */
export interface OpcodeTransform {
  opcodeNumber: number; // Opcode value (e.g., 68)
  opcodeName: string; // Opcode name (e.g., "ADD")
  variables: TransformVariable[]; // List of variable assignments (pre-expressions)
  postVariables: TransformVariable[]; // List of post-execution variable assignments
  sourceLine?: number; // Source line for error reporting
}

export interface VmasmAST {
  format?: string;
  domain?: string;
  source?: string;
  url?: string;
  registers: RegisterMapping;
  dispatcher?: DispatcherInfo;
  globalBytecode?: GlobalBytecodeInfo;
  loopEntry?: LoopEntryInfo;
  constants: ConstantEntry[];
  instructions: InstructionEntry[];
  scopeSlots: ScopeSlotEntry[]; // Scope slot mappings from @scope_slot directives
  opcodeTransforms: Map<number, OpcodeTransform>; // Opcode transform mappings from @opcode_transform directives
  lineToAddr: Map<number, number>;
  addrToLine: Map<number, number>;
}


// ==========================================
// CST Visitor
// ==========================================

const BaseCstVisitor = vmasmParser.getBaseCstVisitorConstructor();

/* eslint-disable @typescript-eslint/no-explicit-any */
class VmasmVisitor extends BaseCstVisitor {
  private currentLineNumber = 0;
  private lineToAddr = new Map<number, number>();
  private addrToLine = new Map<number, number>();

  constructor() {
    super();
    this.validateVisitor();
  }

  program(ctx: any): VmasmAST {
    // Reset maps for each new parse
    this.lineToAddr = new Map<number, number>();
    this.addrToLine = new Map<number, number>();

    const result: VmasmAST = {
      registers: this.getDefaultRegisters(),
      constants: [],
      instructions: [],
      scopeSlots: [], // Initialize scope slots array
      opcodeTransforms: new Map<number, OpcodeTransform>(), // Initialize opcode transforms map
      lineToAddr: new Map(),
      addrToLine: new Map(),
    };

    // 处理 format
    if (ctx.formatDecl) {
      for (const decl of ctx.formatDecl) {
        result.format = this.visit(decl);
      }
    }

    // 处理 domain
    if (ctx.domainDecl) {
      for (const decl of ctx.domainDecl) {
        result.domain = this.visit(decl);
      }
    }

    // 处理 source
    if (ctx.sourceDecl) {
      for (const decl of ctx.sourceDecl) {
        result.source = this.visit(decl);
      }
    }

    // 处理 url
    if (ctx.urlDecl) {
      for (const decl of ctx.urlDecl) {
        result.url = this.visit(decl);
      }
    }

    // 处理 reg
    if (ctx.regDecl) {
      for (const decl of ctx.regDecl) {
        const regs = this.visit(decl);
        result.registers = { ...result.registers, ...regs };
      }
    }

    // 处理 dispatcher
    if (ctx.dispatcherDecl) {
      for (const decl of ctx.dispatcherDecl) {
        const loc = this.visit(decl);
        if (loc.line !== undefined && loc.column !== undefined) {
          result.dispatcher = { location: { line: loc.line, column: loc.column } };
        }
      }
    }

    // 处理 breakpoint (附加到 dispatcher)
    if (ctx.breakpointDecl) {
      for (const decl of ctx.breakpointDecl) {
        const loc = this.visit(decl);
        if (loc.line !== undefined && loc.column !== undefined) {
          if (result.dispatcher) {
            result.dispatcher.breakpoint = { line: loc.line, column: loc.column };
          } else {
            result.dispatcher = {
              location: { line: loc.line, column: loc.column },
              breakpoint: { line: loc.line, column: loc.column },
            };
          }
        }
      }
    }

    // 处理 global_bytecode
    if (ctx.globalBytecodeDecl) {
      for (const decl of ctx.globalBytecodeDecl) {
        const data = this.visit(decl);
        if (data.var && data.line !== undefined && data.column !== undefined) {
          result.globalBytecode = {
            variable: data.var,
            location: { line: data.line, column: data.column },
            pattern: data.pattern || '1d_slice',
            localVariable: data.local,
            // Use transform if provided in @global_bytecode, otherwise default to variable name
            transform: data.transform || data.var,
          };
        }
      }
    }

    // 处理 bytecode_transform (独立指令，覆盖 @global_bytecode 中的 transform)
    if (ctx.bytecodeTransformDecl) {
      for (const decl of ctx.bytecodeTransformDecl) {
        const data = this.visit(decl);
        if (data.expr && result.globalBytecode) {
          result.globalBytecode.transform = data.expr;
        }
      }
    }

    // 处理 opcode_transform
    if (ctx.opcodeTransformDecl) {
      for (const decl of ctx.opcodeTransformDecl) {
        const transform = this.visit(decl) as OpcodeTransform;
        if (transform) {
          // Last definition wins for duplicate opcode numbers
          result.opcodeTransforms.set(transform.opcodeNumber, transform);
        }
      }
    }

    // 处理 loop_entry
    if (ctx.loopEntryDecl) {
      for (const decl of ctx.loopEntryDecl) {
        const data = this.visit(decl);
        if (data.line !== undefined && data.column !== undefined) {
          result.loopEntry = {
            location: { line: data.line, column: data.column },
          };
        }
      }
    }

    // 处理 function_entry (目前只是忽略，不影响 AST)
    if (ctx.functionEntryDecl) {
      for (const decl of ctx.functionEntryDecl) {
        this.visit(decl); // 解析但不存储
      }
    }

    // 处理 scope_slot
    if (ctx.scopeSlotDecl) {
      for (const decl of ctx.scopeSlotDecl) {
        const scopeSlot = this.visit(decl);
        if (scopeSlot) {
          result.scopeSlots.push(scopeSlot);
        }
      }
    }

    // 处理 const
    if (ctx.constDecl) {
      for (const decl of ctx.constDecl) {
        const constant = this.visit(decl);
        if (constant) {
          result.constants.push(constant);
        }
      }
    }

    // 处理 instruction
    if (ctx.instruction) {
      for (const instr of ctx.instruction) {
        const instruction = this.visit(instr);
        if (instruction) {
          result.instructions.push(instruction);
          this.lineToAddr.set(instruction.lineNumber, instruction.addr);
          this.addrToLine.set(instruction.addr, instruction.lineNumber);
        }
      }
    }

    result.lineToAddr = this.lineToAddr;
    result.addrToLine = this.addrToLine;

    return result;
  }


  formatDecl(ctx: any): string {
    return ctx.Identifier[0].image;
  }

  domainDecl(ctx: any): string {
    return ctx.Identifier[0].image;
  }

  sourceDecl(ctx: any): string {
    return ctx.Identifier[0].image;
  }

  urlDecl(ctx: any): string {
    if (ctx.UrlValue) {
      return ctx.UrlValue[0].image;
    }
    return ctx.Identifier[0].image;
  }

  regDecl(ctx: any): Partial<RegisterMapping> {
    const result: Partial<RegisterMapping> = {};
    if (ctx.regMapping) {
      for (const mapping of ctx.regMapping) {
        const { key, value } = this.visit(mapping);
        if (key && value) {
          (result as any)[key] = value;
        }
      }
    }
    return result;
  }

  regMapping(ctx: any): { key: string; value: string } {
    return {
      key: ctx.Identifier[0].image,
      value: ctx.Identifier[1].image,
    };
  }

  dispatcherDecl(ctx: any): Record<string, number> {
    return this.parseLocationMappings(ctx.locationMapping);
  }

  globalBytecodeDecl(ctx: any): Record<string, any> {
    return this.parseLocationMappings(ctx.locationMapping);
  }

  /**
   * Visit @bytecode_transform directive
   * Format: @bytecode_transform expr="z.map(x=>x[0])"
   */
  bytecodeTransformDecl(ctx: any): Record<string, any> {
    return this.parseTransformMappings(ctx.transformMapping);
  }

  /**
   * Visit transform mapping: expr="..."
   */
  transformMapping(ctx: any): { key: string; value: string } {
    const key = ctx.Identifier[0].image;
    let value: string;

    if (ctx.QuotedString) {
      // Remove quotes from string value: "z.map(x=>x[0])" -> z.map(x=>x[0])
      value = ctx.QuotedString[0].image.slice(1, -1);
    } else if (ctx.TransformExpr) {
      value = ctx.TransformExpr[0].image;
    } else if (ctx.Identifier[1]) {
      value = ctx.Identifier[1].image;
    } else {
      value = '';
    }

    return { key, value };
  }


  /**
   * Visit @opcode_transform directive - 整行作为一个 token
   * Format: @opcode_transform <number> <name>: <var1> = <expr1>; <var2> = <expr2>; ...
   * Example: @opcode_transform 68 ADD: a = v[p - 1]; b = v[p]; result = a + b
   *
   * Also supports new quoted format with pre/post prefixes:
   * Example: @opcode_transform 32 LT: "pre:a = v[p - 1]"; "pre:b = v[p]"; "pre:result = a < b"
   *
   * 从整行 token 中解析出 opcode number, name, 和 expressions
   */
  opcodeTransformDecl(ctx: any): OpcodeTransform | null {
    if (!ctx.OpcodeTransformLine) return null;

    const lineToken = ctx.OpcodeTransformLine[0];
    const lineText = lineToken.image;
    const sourceLine = lineToken.startLine;

    // Parse: @opcode_transform 68 ADD: a = v[p - 1]; b = v[p]; result = a + b
    // Also supports -1 as a fallback/default opcode: @opcode_transform -1 DEFAULT: ...
    const match = lineText.match(/@opcode_transform\s+(-?\d+)\s+([A-Z_]+):\s*(.+)/);
    if (!match) return null;

    const opcodeNumber = parseInt(match[1], 10); // Supports negative numbers like -1
    const opcodeName = match[2];
    const expressionsStr = match[3];

    // Parse expressions - handle both old and new formats
    const variables: TransformVariable[] = [];
    const postVariables: TransformVariable[] = [];

    if (isQuotedFormat(expressionsStr)) {
      // New quoted format: "pre:a = v[p - 1]"; "post:result = v[p]"
      const quotedExprs = splitQuotedExpressions(expressionsStr);

      for (const expr of quotedExprs) {
        const parsed = parseQuotedExpression(expr);
        if (parsed) {
          if (parsed.isPost) {
            postVariables.push({ name: parsed.name, expression: parsed.expression, isPost: true });
          } else {
            variables.push({ name: parsed.name, expression: parsed.expression, isPost: false });
          }
        }
      }
    } else {
      // Old unquoted format: a = v[p - 1]; b = v[p]; result = a + b
      const assignments = expressionsStr
        .split(';')
        .map((s: string) => s.trim())
        .filter((s: string) => s);

      for (const assignment of assignments) {
        const eqIndex = assignment.indexOf('=');
        if (eqIndex > 0) {
          const name = assignment.substring(0, eqIndex).trim();
          const expression = assignment.substring(eqIndex + 1).trim();
          variables.push({ name, expression, isPost: false });
        }
      }
    }

    return {
      opcodeNumber,
      opcodeName,
      variables,
      postVariables,
      sourceLine,
    };
  }

  loopEntryDecl(ctx: any): Record<string, any> {
    return this.parseLocationMappings(ctx.locationMapping);
  }

  functionEntryDecl(ctx: any): Record<string, any> {
    return this.parseLocationMappings(ctx.locationMapping);
  }

  breakpointDecl(ctx: any): Record<string, number> {
    return this.parseLocationMappings(ctx.locationMapping);
  }


  /**
   * Visit @scope_slot directive and extract scope slot entry
   * Format: @scope_slot depth=N, index=M, name="X", first_use="..."
   */
  scopeSlotDecl(ctx: any): ScopeSlotEntry | null {
    const mappings = this.parseScopeSlotMappings(ctx.scopeSlotMapping);

    // depth and index are required
    if (mappings.depth === undefined || mappings.index === undefined) {
      return null;
    }

    return {
      depth: mappings.depth,
      index: mappings.index,
      name: mappings.name || '?',
      firstUse: mappings.first_use,
      sourceLine: mappings.source_line,
      sourceColumn: mappings.source_column,
    };
  }

  /**
   * Visit individual key=value mapping in @scope_slot
   */
  scopeSlotMapping(ctx: any): { key: string; value: string | number } {
    const key = ctx.Identifier[0].image;
    let value: string | number;

    if (ctx.NumericLiteral) {
      value = parseInt(ctx.NumericLiteral[0].image, 10);
    } else if (ctx.QuotedString) {
      // Remove quotes from string value
      value = ctx.QuotedString[0].image.slice(1, -1);
    } else if (ctx.Identifier[1]) {
      value = ctx.Identifier[1].image;
    } else {
      value = '';
    }

    return { key, value };
  }

  locationMapping(ctx: any): { key: string; value: string | number } {
    const key = ctx.Identifier[0].image;
    let value: string | number;

    if (ctx.QuotedString) {
      // Handle quoted strings like "2d_array" or "z.map(x=>x[0])"
      // Remove quotes from string value
      value = ctx.QuotedString[0].image.slice(1, -1);
    } else if (ctx.TransformExpr) {
      // Handle transform expressions like z.map(x=>x[0])
      value = ctx.TransformExpr[0].image;
    } else if (ctx.NumericLiteral) {
      // Handle values like "2d_array" which get tokenized as NumericLiteral + Identifier
      const numPart = ctx.NumericLiteral[0].image;
      if (ctx.Identifier[1]) {
        // Concatenate: "2" + "d_array" = "2d_array"
        value = numPart + ctx.Identifier[1].image;
      } else {
        value = parseInt(numPart, 10);
      }
    } else if (ctx.Identifier[1]) {
      value = ctx.Identifier[1].image;
    } else {
      value = '';
    }

    return { key, value };
  }


  constDecl(ctx: any): ConstantEntry | null {
    const kref = ctx.KRef[0].image;
    const indexMatch = kref.match(/K\[(\d+)\]/);
    if (!indexMatch) return null;

    const index = parseInt(indexMatch[1], 10);
    const typedValue = this.visit(ctx.typedValue[0]);

    return {
      index,
      ...typedValue,
    };
  }

  typedValue(ctx: any): { type: ConstantEntry['type']; value: any } {
    if (ctx.TypeString) {
      const str = ctx.QuotedString[0].image;
      return { type: 'String', value: str.slice(1, -1) }; // 去掉引号
    }
    if (ctx.TypeNumber) {
      return { type: 'Number', value: parseFloat(ctx.NumericLiteral[0].image) };
    }
    if (ctx.TypeBoolean) {
      return { type: 'Boolean', value: ctx.BooleanLiteral[0].image === 'true' };
    }
    if (ctx.TypeNull) {
      return { type: 'Null', value: null };
    }
    if (ctx.TypeObject) {
      const str = ctx.QuotedString[0].image;
      return { type: 'Object', value: str.slice(1, -1) };
    }
    return { type: 'Null', value: null };
  }

  instruction(ctx: any): InstructionEntry | null {
    const addrToken = ctx.HexAddress[0];
    const addrStr = addrToken.image.replace(':', '');
    const addr = parseInt(addrStr, 16);
    const opcode = ctx.Identifier[0].image;

    const operands: string[] = [];
    if (ctx.operand) {
      for (const op of ctx.operand) {
        operands.push(this.visit(op));
      }
    }

    // 使用 token 的行号 (Chevrotain 的 startLine 是 1-based)
    const lineNumber = addrToken.startLine;

    if (lineNumber === undefined || lineNumber === null) {
      console.warn(`[VmasmVisitor] Token has no startLine: ${addrToken.image}`);
      return null;
    }

    return {
      addr,
      opcode,
      operands,
      lineNumber,
    };
  }

  operand(ctx: any): string {
    if (ctx.KRef) return ctx.KRef[0].image;
    if (ctx.VRef) return ctx.VRef[0].image;
    if (ctx.HexAddress) return ctx.HexAddress[0].image;
    if (ctx.NumericLiteral) return ctx.NumericLiteral[0].image;
    if (ctx.QuotedString) return ctx.QuotedString[0].image;
    if (ctx.Identifier) return ctx.Identifier[0].image;
    return '';
  }

  // 空实现 - 这些节点不需要返回值
  sectionDecl(_ctx: any): void {
    // Section declarations are structural, no value needed
  }

  entryDecl(_ctx: any): void {
    // Entry declarations are handled elsewhere
  }

  funcDecl(_ctx: any): void {
    // Function declarations are handled elsewhere
  }


  // ==========================================
  // 辅助方法
  // ==========================================

  private parseLocationMappings(mappings: any[]): Record<string, any> {
    const result: Record<string, any> = {};
    if (mappings) {
      for (const mapping of mappings) {
        const { key, value } = this.visit(mapping);
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Parse transform mappings from @bytecode_transform directive
   * Returns an object with expr field
   */
  private parseTransformMappings(mappings: any[]): Record<string, any> {
    const result: Record<string, any> = {};
    if (mappings) {
      for (const mapping of mappings) {
        const { key, value } = this.visit(mapping);
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Parse scope slot mappings from @scope_slot directive
   * Returns an object with depth, index, name, first_use, source_line, source_column
   */
  private parseScopeSlotMappings(mappings: any[]): Record<string, any> {
    const result: Record<string, any> = {};
    if (mappings) {
      for (const mapping of mappings) {
        const { key, value } = this.visit(mapping);
        result[key] = value;
      }
    }
    return result;
  }

  private getDefaultRegisters(): RegisterMapping {
    return {
      ip: 'ip',
      sp: 'sp',
      stack: 'stack',
      bc: 'bc',
      storage: 'storage',
      const: 'const',
      scope: 'scope',
    };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// 创建 Visitor 单例
export const vmasmVisitor = new VmasmVisitor();


// ==========================================
// Parser API
// ==========================================

import { VmasmLexer } from './vmasm-lexer.js';

export interface ParseError {
  type: 'lexer' | 'parser' | 'visitor';
  message: string;
  line?: number;
  column?: number;
  token?: string;
}

export type ParseResult = VmasmAST | ParseError;

/**
 * Parse vmasm content string into AST
 * @param content - The vmasm file content
 * @returns VmasmAST on success, ParseError on failure
 */
export function parseVmasm(content: string): ParseResult {
  // Lexer phase
  const lexResult = VmasmLexer.tokenize(content);
  if (lexResult.errors.length > 0) {
    const err = lexResult.errors[0];
    return {
      type: 'lexer',
      message: err.message,
      line: err.line,
      column: err.column,
    };
  }

  // Parser phase
  vmasmParser.input = lexResult.tokens;
  const cst = vmasmParser.program();

  if (vmasmParser.errors.length > 0) {
    const err = vmasmParser.errors[0];
    return {
      type: 'parser',
      message: err.message,
      line: err.token?.startLine,
      column: err.token?.startColumn,
      token: err.token?.image,
    };
  }

  // Visitor phase
  try {
    const ast = vmasmVisitor.visit(cst);
    return ast;
  } catch (e) {
    return {
      type: 'visitor',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Check if a parse result is an error
 */
export function isParseError(result: ParseResult): result is ParseError {
  return 'type' in result && ['lexer', 'parser', 'visitor'].includes(result.type);
}
