/**
 * Debug File Generator
 *
 * Generates debug files from vmasm metadata by injecting breakpoint checking logic
 * into the original JavaScript source files.
 *
 * Ported from jsvmp-ir-extension for rc-devtools-mcp
 * Requirements: 8.3, 8.4, 8.5
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  VmasmAST,
  RegisterMapping,
  DispatcherInfo,
  GlobalBytecodeInfo,
  LoopEntryInfo,
} from './vmasm-visitor.js';

// ==========================================
// Interfaces
// ==========================================

/**
 * Configuration for debug file generation
 */
export interface GenerationConfig {
  /** Path to .vmasm file */
  vmasmPath: string;
  /** Optional custom output directory */
  outputDir?: string;
  /** Optional source file path override (if not specified in vmasm @source) */
  sourceFilePath?: string;
}

/**
 * Result of debug file generation
 */
export interface GenerationResult {
  success: boolean;
  /** Path to generated debug file */
  debugFilePath?: string;
  /** URL pattern for interception */
  urlPattern?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Debug file mapping entry
 */
export interface DebugFileMapping {
  vmasmPath: string;
  sourcePath: string;
  debugPath: string;
  urlPattern: string;
  lastGenerated: Date;
}

/**
 * Interception configuration for script replacement
 * Requirements: 8.4
 */
export interface InterceptionConfig {
  /** URL pattern to match for interception (from @url directive) */
  scriptPattern: string;
  /** Path to the debug file to serve */
  debugFilePath: string;
}

/**
 * Configuration for breakpoint injection
 */
export interface InjectionConfig {
  /** Original JavaScript source code */
  sourceCode: string;

  /** Location from @global_bytecode - where to inject window.__global_bytecode assignment */
  globalBytecodeLocation?: {
    line: number; // 1-based line number
    column: number; // 0-based column number
  };

  /** Location from @loop_entry - where to insert offset calculation (inside dispatcher loop, before opcode read) */
  functionEntryLocation: {
    line: number; // 1-based line number
    column: number; // 0-based column number
  };

  /** Location from @breakpoint - where to insert breakpoint check */
  breakpointLocation: {
    line: number;
    column: number;
  };

  /** Location from @dispatcher - where to insert breakpoint check (before dispatcher) */
  dispatcherLocation: {
    line: number;
    column: number;
  };

  /** Register names from @reg directive */
  registers: {
    ip: string; // Instruction pointer register (e.g., 'a')
    bc: string; // Local bytecode register (e.g., 'o')
    sp?: string; // Stack pointer register (optional, e.g., 's')
  };

  /** Global bytecode variable name from @global_bytecode (e.g., 'Z' or 'r.d') */
  globalBytecodeVar: string;

  /** Pattern type for offset calculation */
  patternType?: '2d_array' | '1d_slice';

  /** Local bytecode variable name (for 2d_array pattern) */
  localBytecodeVar?: string;

  /** Transform expression for global bytecode (e.g., "z.map(x=>x[0])") */
  transformExpression?: string;
}

/**
 * Result of breakpoint injection
 */
export interface InjectionResult {
  success: boolean;
  /** Transformed code if successful */
  code?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Logger interface for output
 */
export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

/**
 * Default console logger - outputs JSON format for MCP compatibility
 */
const defaultLogger: Logger = {
  log: (message: string) => console.error(JSON.stringify({ level: 'info', source: 'DebugFileGenerator', message })),
  error: (message: string) => console.error(JSON.stringify({ level: 'error', source: 'DebugFileGenerator', message })),
};

// ==========================================
// Vmasm Metadata Interface (for compatibility)
// ==========================================

/**
 * Vmasm metadata interface (matches VmasmAST structure)
 */
export interface VmasmMetadata {
  format?: string;
  domain?: string;
  source?: string;
  url?: string;
  registers: RegisterMapping;
  dispatcher?: DispatcherInfo;
  globalBytecode?: GlobalBytecodeInfo;
  loopEntry?: LoopEntryInfo;
}


// ==========================================
// DebugFileGenerator Class
// ==========================================

/**
 * DebugFileGenerator orchestrates the generation of debug files
 * from vmasm metadata by injecting breakpoint checking logic.
 *
 * Uses string-based injection at precise line/column locations
 * specified in the vmasm file directives.
 */
export class DebugFileGenerator {
  private fileMapping: Map<string, DebugFileMapping>;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.fileMapping = new Map();
    this.logger = logger || defaultLogger;
  }

  /**
   * Generate debug file for a vmasm file
   * Only generates if debug file doesn't exist
   *
   * @param config - Generation configuration
   * @param metadata - Parsed vmasm metadata (VmasmAST)
   * @returns GenerationResult
   */
  async generate(
    config: GenerationConfig,
    metadata: VmasmMetadata
  ): Promise<GenerationResult> {
    const { vmasmPath, outputDir, sourceFilePath } = config;

    try {
      // Check if source path is specified
      const sourcePath = sourceFilePath || metadata.source;
      if (!sourcePath) {
        return {
          success: false,
          error: 'Missing @source directive in vmasm file and no sourceFilePath provided',
        };
      }

      // Resolve source file path
      const resolvedSourcePath = this.resolveSourcePath(vmasmPath, sourcePath);

      // Get debug file path
      const debugPath = outputDir
        ? path.join(outputDir, path.basename(this.getDebugFilePath(resolvedSourcePath)))
        : this.getDebugFilePath(resolvedSourcePath);

      // Check if debug file already exists
      try {
        await fs.access(debugPath);
        this.logger.log(`Debug file already exists: ${debugPath}`);

        // Update file mapping
        this.fileMapping.set(vmasmPath, {
          vmasmPath,
          sourcePath: resolvedSourcePath,
          debugPath,
          urlPattern: metadata.url || '',
          lastGenerated: new Date(),
        });

        return {
          success: true,
          debugFilePath: debugPath,
          urlPattern: metadata.url,
        };
      } catch {
        // File doesn't exist, continue with generation
      }

      // Check if source file exists
      try {
        await fs.access(resolvedSourcePath);
      } catch {
        const attemptedPaths = this.getAttemptedPaths(vmasmPath, sourcePath);
        const errorMessage = this.formatSourceNotFoundError(sourcePath, attemptedPaths);
        this.logger.error(errorMessage);
        return {
          success: false,
          error: errorMessage,
        };
      }

      // Read source file
      const sourceCode = await fs.readFile(resolvedSourcePath, 'utf-8');

      // Build injection config
      const injectionConfig = this.buildInjectionConfig(sourceCode, metadata);
      if (!injectionConfig) {
        return {
          success: false,
          error: 'Failed to build injection config from vmasm metadata',
        };
      }

      // Perform injection
      const injectionResult = this.inject(injectionConfig);
      if (!injectionResult.success || !injectionResult.code) {
        return {
          success: false,
          error: injectionResult.error || 'Injection failed',
        };
      }

      // Ensure output directory exists
      const debugDir = path.dirname(debugPath);
      await fs.mkdir(debugDir, { recursive: true });

      // Write debug file
      await fs.writeFile(debugPath, injectionResult.code, 'utf-8');
      this.logger.log(`Generated debug file: ${debugPath}`);

      // Update file mapping
      this.fileMapping.set(vmasmPath, {
        vmasmPath,
        sourcePath: resolvedSourcePath,
        debugPath,
        urlPattern: metadata.url || '',
        lastGenerated: new Date(),
      });

      return {
        success: true,
        debugFilePath: debugPath,
        urlPattern: metadata.url,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to generate debug file: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Force regenerate debug file (used for manual refresh)
   * Regenerates even if debug file already exists
   */
  async forceRegenerate(
    config: GenerationConfig,
    metadata: VmasmMetadata
  ): Promise<GenerationResult> {
    const { vmasmPath, outputDir, sourceFilePath } = config;

    try {
      // Check if source path is specified
      const sourcePath = sourceFilePath || metadata.source;
      if (!sourcePath) {
        return {
          success: false,
          error: 'Missing @source directive in vmasm file and no sourceFilePath provided',
        };
      }

      // Resolve source file path
      const resolvedSourcePath = this.resolveSourcePath(vmasmPath, sourcePath);

      // Get debug file path
      const debugPath = outputDir
        ? path.join(outputDir, path.basename(this.getDebugFilePath(resolvedSourcePath)))
        : this.getDebugFilePath(resolvedSourcePath);

      // Check if source file exists
      try {
        await fs.access(resolvedSourcePath);
      } catch {
        const attemptedPaths = this.getAttemptedPaths(vmasmPath, sourcePath);
        const errorMessage = this.formatSourceNotFoundError(sourcePath, attemptedPaths);
        this.logger.error(errorMessage);
        return {
          success: false,
          error: errorMessage,
        };
      }

      // Read source file
      const sourceCode = await fs.readFile(resolvedSourcePath, 'utf-8');

      // Build injection config
      const injectionConfig = this.buildInjectionConfig(sourceCode, metadata);
      if (!injectionConfig) {
        return {
          success: false,
          error: 'Failed to build injection config from vmasm metadata',
        };
      }

      // Perform injection
      const injectionResult = this.inject(injectionConfig);
      if (!injectionResult.success || !injectionResult.code) {
        return {
          success: false,
          error: injectionResult.error || 'Injection failed',
        };
      }

      // Ensure output directory exists
      const debugDir = path.dirname(debugPath);
      await fs.mkdir(debugDir, { recursive: true });

      // Write debug file (overwrite if exists)
      await fs.writeFile(debugPath, injectionResult.code, 'utf-8');
      this.logger.log(`Regenerated debug file: ${debugPath}`);

      // Update file mapping
      this.fileMapping.set(vmasmPath, {
        vmasmPath,
        sourcePath: resolvedSourcePath,
        debugPath,
        urlPattern: metadata.url || '',
        lastGenerated: new Date(),
      });

      return {
        success: true,
        debugFilePath: debugPath,
        urlPattern: metadata.url,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to regenerate debug file: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Build InjectionConfig from vmasm metadata
   * Extracts @loop_entry, @breakpoint, @dispatcher, @global_bytecode, @reg information
   * Returns null with detailed error logging if required directives are missing
   */
  buildInjectionConfig(
    sourceCode: string,
    metadata: VmasmMetadata
  ): InjectionConfig | null {
    // Collect all missing directives for comprehensive error reporting
    const missingDirectives: string[] = [];

    // Check @loop_entry
    if (!metadata.loopEntry) {
      missingDirectives.push('@loop_entry');
    }

    // Check @dispatcher location
    if (!metadata.dispatcher?.location) {
      missingDirectives.push('@dispatcher');
    }

    // Check @breakpoint (inside dispatcher)
    if (!metadata.dispatcher?.breakpoint) {
      missingDirectives.push('@breakpoint');
    }

    // Check @global_bytecode
    if (!metadata.globalBytecode) {
      missingDirectives.push('@global_bytecode');
    }

    // Check required registers
    if (!metadata.registers.ip) {
      missingDirectives.push('@reg ip=...');
    }
    if (!metadata.registers.bc) {
      missingDirectives.push('@reg bc=...');
    }

    // If any directives are missing, report them all at once
    if (missingDirectives.length > 0) {
      const errorMessage = this.formatMissingDirectivesError(missingDirectives);
      this.logger.error(errorMessage);
      return null;
    }

    return {
      sourceCode,
      globalBytecodeLocation: metadata.globalBytecode!.location
        ? {
            line: metadata.globalBytecode!.location.line,
            column: metadata.globalBytecode!.location.column,
          }
        : undefined,
      functionEntryLocation: {
        line: metadata.loopEntry!.location.line,
        column: metadata.loopEntry!.location.column,
      },
      breakpointLocation: {
        line: metadata.dispatcher!.breakpoint!.line,
        column: metadata.dispatcher!.breakpoint!.column,
      },
      dispatcherLocation: {
        line: metadata.dispatcher!.location.line,
        column: metadata.dispatcher!.location.column,
      },
      registers: {
        ip: metadata.registers.ip,
        bc: metadata.registers.bc,
        sp: metadata.registers.sp,
      },
      globalBytecodeVar: metadata.globalBytecode!.variable,
      patternType: metadata.globalBytecode!.pattern,
      localBytecodeVar: metadata.globalBytecode!.localVariable,
      transformExpression: metadata.globalBytecode!.transform,
    };
  }


  /**
   * Perform breakpoint injection using string-based manipulation
   * Inserts code at precise line/column locations
   */
  inject(config: InjectionConfig): InjectionResult {
    try {
      const lines = config.sourceCode.split('\n');

      // Collect all insertions with their positions
      // We'll sort them by position (line, column) in reverse order
      // so that later insertions don't affect earlier positions
      const insertions: Array<{
        line: number;
        column: number;
        code: string;
        type: 'before' | 'after';
      }> = [];

      // Step 1: Global bytecode assignment (insert after the location)
      if (config.globalBytecodeLocation) {
        const globalBytecodeCode = this.createGlobalBytecodeAssignment(
          config.globalBytecodeVar,
          config.transformExpression
        );
        insertions.push({
          line: config.globalBytecodeLocation.line,
          column: config.globalBytecodeLocation.column,
          code: globalBytecodeCode,
          type: 'after',
        });
      }

      // Step 2: Call stack initialization (insert before the loop at functionEntryLocation)
      const callStackInitCode = this.createCallStackInit();
      insertions.push({
        line: config.functionEntryLocation.line,
        column: config.functionEntryLocation.column,
        code: callStackInitCode,
        type: 'before',
      });

      // Step 3: Offset calculation (insert before the loop at functionEntryLocation)
      const patternType = config.patternType || '1d_slice';
      const offsetCalcCode =
        patternType === '2d_array'
          ? this.createOffsetCalculation2D(config.localBytecodeVar || config.registers.bc)
          : this.createOffsetCalculation(config.registers.bc);
      insertions.push({
        line: config.functionEntryLocation.line,
        column: config.functionEntryLocation.column,
        code: offsetCalcCode,
        type: 'before',
      });

      // Step 4: Initial frame push (insert before the loop at functionEntryLocation)
      const initialFramePushCode = this.createInitialFramePush(
        config.registers.bc,
        config.registers.sp
      );
      insertions.push({
        line: config.functionEntryLocation.line,
        column: config.functionEntryLocation.column,
        code: initialFramePushCode,
        type: 'before',
      });

      // Step 5: Frame update (insert before breakpoint location)
      const frameUpdateCode = this.createFrameUpdate(config.registers.ip, config.registers.sp);
      insertions.push({
        line: config.breakpointLocation.line,
        column: config.breakpointLocation.column,
        code: frameUpdateCode,
        type: 'before',
      });

      // Step 6: Bytecode change check (insert before breakpoint location)
      const bytecodeChangeCheckCode = this.createBytecodeChangeCheck(
        config.registers.bc,
        config.registers.ip,
        config.registers.sp,
        patternType
      );
      insertions.push({
        line: config.breakpointLocation.line,
        column: config.breakpointLocation.column,
        code: bytecodeChangeCheckCode,
        type: 'before',
      });

      // Step 7: Breakpoint check (insert before dispatcher location)
      const breakpointCheckCode = this.createBreakpointCheck(config.registers.ip);
      insertions.push({
        line: config.dispatcherLocation.line,
        column: config.dispatcherLocation.column,
        code: breakpointCheckCode,
        type: 'before',
      });

      // Sort insertions by line (descending), then by column (descending)
      // Process from bottom to top, right to left to avoid position shifts
      insertions.sort((a, b) => {
        if (a.line !== b.line) return b.line - a.line;
        return b.column - a.column;
      });

      // Apply insertions
      for (const insertion of insertions) {
        const lineIndex = insertion.line - 1; // Convert to 0-based
        if (lineIndex < 0 || lineIndex >= lines.length) {
          return {
            success: false,
            error: `Invalid line number: ${insertion.line}`,
          };
        }

        const line = lines[lineIndex];
        const column = insertion.column;

        if (column < 0 || column > line.length) {
          return {
            success: false,
            error: `Invalid column ${column} for line ${insertion.line} (line length: ${line.length})`,
          };
        }

        if (insertion.type === 'before') {
          // Insert code before the position
          lines[lineIndex] = line.slice(0, column) + insertion.code + line.slice(column);
        } else {
          // Insert code after the position (find end of statement)
          // For simplicity, insert at the end of the line with a semicolon
          lines[lineIndex] = line + insertion.code;
        }
      }

      return {
        success: true,
        code: lines.join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==========================================
  // Code Generation Methods
  // ==========================================

  /**
   * Generate global bytecode assignment code
   * Uses Object.defineProperty with a getter for lazy evaluation
   */
  private createGlobalBytecodeAssignment(
    globalBytecodeVar: string,
    transformExpression?: string
  ): string {
    const expr = transformExpression || globalBytecodeVar;
    return `;try{Object.defineProperty(window,'__global_bytecode',{get:function(){var v=${expr};Object.defineProperty(window,'__global_bytecode',{value:v,writable:true});return v},configurable:true})}catch(e){window.__jsvmp_error=e}`;
  }

  /**
   * Generate call stack initialization code
   */
  private createCallStackInit(): string {
    return 'var __jsvmp_call_stack=[];';
  }

  /**
   * Generate offset calculation code for 1D slice pattern
   */
  private createOffsetCalculation(bcRegister: string): string {
    return `var __jsvmp_offset=(function(){try{var gb=window.__global_bytecode;if(!gb)return 0;var MATCH_LEN=10;var pattern=${bcRegister}.slice(0,MATCH_LEN);for(var i=0;i<=gb.length-MATCH_LEN;i++){if(pattern.every(function(v,j){return v===gb[i+j]}))return i}return 0}catch(e){window.__jsvmp_error=e;return 0}})();`;
  }

  /**
   * Generate offset calculation code for 2D array pattern
   */
  private createOffsetCalculation2D(localBytecodeVar: string): string {
    return `var __jsvmp_offset=(function(){try{var gb=window.__global_bytecode;if(!gb||!Array.isArray(gb))return 0;var local=${localBytecodeVar};if(!local||!local.length)return 0;var MATCH_LEN=Math.min(10,local.length);var offset=0;for(var i=0;i<gb.length;i++){var sub=gb[i];if(!sub)continue;if(sub.length>=MATCH_LEN&&local.slice(0,MATCH_LEN).every(function(v,j){return v===sub[j]}))return offset;offset+=sub.length}return 0}catch(e){window.__jsvmp_error=e;return 0}})();`;
  }

  /**
   * Generate initial frame push code
   */
  private createInitialFramePush(bcRegister: string, spRegister?: string): string {
    const spPart = spRegister ? `,sp:${spRegister}` : '';
    return `try{__jsvmp_call_stack.push({bc:${bcRegister},ip:0,offset:__jsvmp_offset${spPart}});window.__jsvmp_call_stack=__jsvmp_call_stack}catch(e){window.__jsvmp_error=e}`;
  }

  /**
   * Generate frame update code
   */
  private createFrameUpdate(ipRegister: string, spRegister?: string): string {
    const spUpdate = spRegister ? `__f.sp=${spRegister};` : '';
    return `try{var __f=__jsvmp_call_stack[__jsvmp_call_stack.length-1];if(__f){__f.ip=${ipRegister};${spUpdate}}}catch(e){window.__jsvmp_error=e}`;
  }

  /**
   * Generate bytecode change check code
   */
  private createBytecodeChangeCheck(
    bcRegister: string,
    ipRegister: string,
    spRegister: string | undefined,
    patternType: '2d_array' | '1d_slice'
  ): string {
    const offsetRecalc =
      patternType === '2d_array'
        ? this.createOffsetRecalculation2D(bcRegister)
        : this.createOffsetRecalculation(bcRegister);
    const spPart = spRegister ? `,sp:${spRegister}` : '';
    return `try{var __f=__jsvmp_call_stack[__jsvmp_call_stack.length-1];if(__f&&${bcRegister}!==__f.bc){var __new_offset=${offsetRecalc};__jsvmp_call_stack.push({bc:${bcRegister},ip:${ipRegister},offset:__new_offset${spPart}});__jsvmp_offset=__new_offset;window.__jsvmp_call_stack=__jsvmp_call_stack}}catch(e){window.__jsvmp_error=e}`;
  }

  /**
   * Generate offset recalculation IIFE for 1D slice pattern
   */
  private createOffsetRecalculation(bcRegister: string): string {
    return `(function(){var gb=window.__global_bytecode;if(!gb)return 0;var MATCH_LEN=10;var pattern=${bcRegister}.slice(0,MATCH_LEN);for(var i=0;i<=gb.length-MATCH_LEN;i++){if(pattern.every(function(v,j){return v===gb[i+j]}))return i}return 0})()`;
  }

  /**
   * Generate offset recalculation IIFE for 2D array pattern
   */
  private createOffsetRecalculation2D(bcRegister: string): string {
    return `(function(){var gb=window.__global_bytecode;if(!gb||!Array.isArray(gb))return 0;var local=${bcRegister};if(!local||!local.length)return 0;var MATCH_LEN=Math.min(10,local.length);var offset=0;for(var i=0;i<gb.length;i++){var sub=gb[i];if(!sub)continue;if(sub.length>=MATCH_LEN&&local.slice(0,MATCH_LEN).every(function(v,j){return v===sub[j]}))return offset;offset+=sub.length}return 0})()`;
  }

  /**
   * Generate breakpoint check code
   */
  private createBreakpointCheck(ipRegister: string): string {
    return `if(window.__breakpoints&&window.__breakpoints.has(${ipRegister}+__jsvmp_offset))debugger;`;
  }


  // ==========================================
  // Path Resolution Methods
  // ==========================================

  /**
   * Resolve source file path from @source directive
   * Handles both relative and absolute paths
   */
  resolveSourcePath(vmasmPath: string, sourcePath: string): string {
    // If sourcePath is already absolute, return it directly
    if (path.isAbsolute(sourcePath)) {
      return path.normalize(sourcePath);
    }

    // Get the directory containing the vmasm file
    const vmasmDir = path.dirname(vmasmPath);

    // Resolve the relative path from vmasm directory
    const resolvedPath = path.resolve(vmasmDir, sourcePath);

    return path.normalize(resolvedPath);
  }

  /**
   * Get the debug file path for a source file
   * Generates *_debug.js filename based on source filename
   * Example: bdms.js -> bdms_debug.js
   */
  getDebugFilePath(sourceFilePath: string): string {
    const dir = path.dirname(sourceFilePath);
    const ext = path.extname(sourceFilePath);
    const basename = path.basename(sourceFilePath, ext);

    // Generate debug filename: {basename}_debug{ext}
    const debugFilename = `${basename}_debug${ext}`;

    return path.join(dir, debugFilename);
  }

  /**
   * Get all attempted paths for source file resolution
   * Used for detailed error reporting when source file is not found
   */
  getAttemptedPaths(vmasmPath: string, sourcePath: string): string[] {
    const attemptedPaths: string[] = [];
    const vmasmDir = path.dirname(vmasmPath);

    // Primary resolved path
    const primaryPath = this.resolveSourcePath(vmasmPath, sourcePath);
    attemptedPaths.push(primaryPath);

    // If it's a relative path, also try some common variations
    if (!path.isAbsolute(sourcePath)) {
      // Try without leading ../
      if (sourcePath.startsWith('../')) {
        const withoutParent = sourcePath.replace(/^\.\.\//, '');
        const altPath = path.resolve(vmasmDir, withoutParent);
        if (!attemptedPaths.includes(altPath)) {
          attemptedPaths.push(altPath);
        }
      }

      // Try in the same directory as vmasm
      const sameDir = path.join(vmasmDir, path.basename(sourcePath));
      if (!attemptedPaths.includes(sameDir)) {
        attemptedPaths.push(sameDir);
      }

      // Try in parent directory
      const parentDir = path.join(path.dirname(vmasmDir), path.basename(sourcePath));
      if (!attemptedPaths.includes(parentDir)) {
        attemptedPaths.push(parentDir);
      }
    }

    return attemptedPaths;
  }

  // ==========================================
  // Error Formatting Methods
  // ==========================================

  /**
   * Format a clear error message when required injection point directives are missing
   */
  formatMissingDirectivesError(missingDirectives: string[]): string {
    const lines = [
      'Missing required injection point directives in vmasm file',
      '',
      'Missing directives:',
    ];

    for (const directive of missingDirectives) {
      lines.push(`  - ${directive}`);
    }

    lines.push('');
    lines.push('Required directives for breakpoint injection:');
    lines.push(
      '  @dispatcher line=N, column=M              - Where to insert breakpoint check (before dispatcher)'
    );
    lines.push(
      '  @loop_entry line=N, column=M              - Where to insert offset calculation (inside dispatcher loop, before opcode read)'
    );
    lines.push(
      '  @breakpoint line=N, column=M              - Breakpoint location (after opcode read)'
    );
    lines.push('  @global_bytecode var=Z, line=N, column=M  - Global bytecode variable');
    lines.push('  @reg ip=a, bc=o, ...                      - Register mappings (ip and bc required)');
    lines.push('');
    lines.push('Please ensure your vmasm file contains all required directives.');

    return lines.join('\n');
  }

  /**
   * Format a clear error message when source file is not found
   */
  formatSourceNotFoundError(sourceDirective: string, attemptedPaths: string[]): string {
    const lines = ['Source file not found', '', `@source directive: ${sourceDirective}`, '', 'Attempted paths:'];

    for (const p of attemptedPaths) {
      lines.push(`  - ${p}`);
    }

    lines.push('');
    lines.push('Please verify that:');
    lines.push('  1. The @source path in the vmasm file is correct');
    lines.push('  2. The source JavaScript file exists at the specified location');
    lines.push("  3. The path is relative to the vmasm file's directory");

    return lines.join('\n');
  }

  // ==========================================
  // File Mapping Methods
  // ==========================================

  /**
   * Get the file mapping for a vmasm file
   */
  getFileMapping(vmasmPath: string): DebugFileMapping | undefined {
    return this.fileMapping.get(vmasmPath);
  }

  /**
   * Check if debug file exists for a vmasm file
   */
  async hasDebugFile(vmasmPath: string): Promise<boolean> {
    // First check in-memory mapping
    const mapping = this.fileMapping.get(vmasmPath);
    if (mapping) {
      try {
        await fs.access(mapping.debugPath);
        return true;
      } catch {
        // File doesn't exist
      }
    }
    return false;
  }

  /**
   * Get the debug file path for a vmasm file (even if not in mapping)
   * Returns null if cannot be determined
   */
  getDebugFilePathForVmasm(vmasmPath: string, metadata?: VmasmMetadata): string | null {
    // First check in-memory mapping
    const mapping = this.fileMapping.get(vmasmPath);
    if (mapping) {
      return mapping.debugPath;
    }

    // Try to compute from vmasm metadata
    if (!metadata || !metadata.source) {
      return null;
    }

    const sourcePath = this.resolveSourcePath(vmasmPath, metadata.source);
    return this.getDebugFilePath(sourcePath);
  }

  /**
   * Configure script interception for a vmasm file
   * Gets @url from vmasm metadata and auto-configures scriptPattern and debugFilePath
   *
   * @param vmasmPath - Path to the vmasm file
   * @returns InterceptionConfig if successful, null otherwise
   */
  configureInterception(vmasmPath: string): InterceptionConfig | null {
    // Get file mapping for this vmasm file
    const mapping = this.fileMapping.get(vmasmPath);

    if (!mapping) {
      this.logger.error(`No file mapping found for: ${vmasmPath}`);
      return null;
    }

    // Get URL pattern from mapping (extracted from @url directive)
    if (!mapping.urlPattern) {
      this.logger.error(`No URL pattern found in vmasm metadata for: ${vmasmPath}`);
      return null;
    }

    const config: InterceptionConfig = {
      scriptPattern: mapping.urlPattern,
      debugFilePath: mapping.debugPath,
    };

    this.logger.log(`Configured interception: pattern="${config.scriptPattern}", file="${config.debugFilePath}"`);

    return config;
  }

  /**
   * Clear all file mappings
   */
  clearMappings(): void {
    this.fileMapping.clear();
  }
}

// ==========================================
// Singleton Instance
// ==========================================

/**
 * Global debug file generator instance
 */
let globalDebugFileGenerator: DebugFileGenerator | null = null;

/**
 * Get the global debug file generator instance
 */
export function getDebugFileGenerator(): DebugFileGenerator {
  if (!globalDebugFileGenerator) {
    globalDebugFileGenerator = new DebugFileGenerator();
  }
  return globalDebugFileGenerator;
}

/**
 * Reset the global debug file generator
 */
export function resetDebugFileGenerator(): void {
  if (globalDebugFileGenerator) {
    globalDebugFileGenerator.clearMappings();
  }
  globalDebugFileGenerator = null;
}

// ==========================================
// URL Pattern Matching Utilities
// ==========================================

/**
 * Convert a URL pattern with wildcards to a RegExp
 * Supports:
 * - * matches any characters (non-greedy)
 * - ** matches any characters (greedy)
 * - ? matches a single character
 *
 * @param pattern - URL pattern with wildcards
 * @returns RegExp for matching URLs
 */
export function urlPatternToRegex(pattern: string): RegExp {
  // Escape special regex characters except our wildcards
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
    .replace(/\*\*/g, '{{DOUBLE_STAR}}') // Temporarily replace **
    .replace(/\*/g, '[^/]*') // * matches any chars except /
    .replace(/\?/g, '.') // ? matches single char
    .replace(/{{DOUBLE_STAR}}/g, '.*'); // ** matches anything

  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Check if a URL matches a pattern with wildcards
 *
 * @param url - The URL to check
 * @param pattern - The pattern with wildcards
 * @returns true if the URL matches the pattern
 */
export function matchUrlPattern(url: string, pattern: string): boolean {
  const regex = urlPatternToRegex(pattern);
  return regex.test(url);
}

/**
 * Extract the base URL pattern from a full URL
 * Useful for creating interception patterns from @url directive
 *
 * @param url - Full URL or pattern
 * @returns Normalized pattern suitable for interception
 */
export function normalizeUrlPattern(url: string): string {
  // If already contains wildcards, return as-is
  if (url.includes('*') || url.includes('?')) {
    return url;
  }

  // Remove query string and hash for cleaner matching
  const cleanUrl = url.split('?')[0].split('#')[0];

  return cleanUrl;
}

