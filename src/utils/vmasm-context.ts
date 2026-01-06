/**
 * VMASM Context - Session management for vmasm debugging
 *
 * Manages the vmasm debugging session including:
 * - Loaded vmasm files and their ASTs
 * - Breakpoint state management
 * - Address mapping queries
 * - Interception configurations
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 8.1, 8.5
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseVmasm,
  isParseError,
  type VmasmAST,
  type ParseError,
  type RegisterMapping,
  type InstructionEntry,
} from './vmasm-visitor.js';

// ==========================================
// Interfaces
// ==========================================

/**
 * Represents a vmasm breakpoint
 * Requirements: 3.1, 3.2
 */
export interface VmasmBreakpoint {
  /** Unique breakpoint identifier */
  id: string;
  /** Bytecode address (e.g., 0x0000) */
  address: number;
  /** CDP breakpoint ID (set after breakpoint is registered with CDP) */
  cdpBreakpointId?: string;
  /** Optional condition expression */
  condition?: string;
  /** Path to the vmasm file this breakpoint belongs to */
  vmasmPath: string;
  /** Hit count for this breakpoint */
  hitCount: number;
}

/**
 * Configuration for script interception
 * Requirements: 8.4
 */
export interface InterceptionConfig {
  /** URL pattern to match (supports wildcards) */
  urlPattern: string;
  /** Path to the debug file to serve */
  debugFilePath: string;
  /** Whether interception is enabled */
  enabled: boolean;
}

/**
 * Result of loading a vmasm file
 * Requirements: 8.1, 8.2
 */
export interface LoadResult {
  /** Whether the load was successful */
  success: true;
  /** Path to the loaded file */
  filePath: string;
  /** File metadata */
  metadata: {
    format?: string;
    domain?: string;
    source?: string;
    url?: string;
    registers: RegisterMapping;
    instructionCount: number;
    constantCount: number;
  };
}

/**
 * Error result for load operations
 */
export interface LoadError {
  success: false;
  error: string;
  parseError?: ParseError;
}

/**
 * Session state for vmasm debugging
 * Requirements: 8.1, 8.5
 */
export interface VmasmSession {
  /** Map of file path to parsed AST */
  loadedFiles: Map<string, VmasmAST>;
  /** Currently active vmasm file path */
  activeFile?: string;
  /** Map of vmasm file path to breakpoints */
  breakpoints: Map<string, VmasmBreakpoint[]>;
  /** Map of vmasm file path to interception config */
  interceptionConfigs: Map<string, InterceptionConfig>;
  /** Counter for generating unique breakpoint IDs */
  breakpointIdCounter: number;
}

// ==========================================
// VmasmContext Class
// ==========================================

/**
 * Manages vmasm debugging session state
 *
 * Provides methods for:
 * - Loading and caching vmasm files
 * - Managing breakpoints (set, list, remove, clear)
 * - Querying address mappings
 * - Managing interception configurations
 */
export class VmasmContext {
  private session: VmasmSession;

  constructor() {
    this.session = {
      loadedFiles: new Map(),
      breakpoints: new Map(),
      interceptionConfigs: new Map(),
      breakpointIdCounter: 0,
    };
  }

  // ==========================================
  // File Loading and Caching
  // ==========================================

  /**
   * Load a vmasm file and store its AST in the session
   * Requirements: 8.1, 8.2, 8.6, 8.7, 8.8
   *
   * @param filePath - Path to the vmasm file
   * @returns LoadResult on success, LoadError on failure
   */
  async loadFile(filePath: string): Promise<LoadResult | LoadError> {
    // Resolve to absolute path
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);

    // Check if file exists
    try {
      await fs.access(absolutePath);
    } catch {
      return {
        success: false,
        error: `File not found: ${absolutePath}`,
      };
    }

    // Read file content
    let content: string;
    try {
      content = await fs.readFile(absolutePath, 'utf-8');
    } catch (err) {
      return {
        success: false,
        error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Parse vmasm content
    const result = parseVmasm(content);
    if (isParseError(result)) {
      return {
        success: false,
        error: `Parse error at line ${result.line ?? 'unknown'}: ${result.message}`,
        parseError: result,
      };
    }

    // Store AST in session
    this.session.loadedFiles.set(absolutePath, result);

    // Set as active file if no active file
    if (!this.session.activeFile) {
      this.session.activeFile = absolutePath;
    }

    // Initialize breakpoints array for this file
    if (!this.session.breakpoints.has(absolutePath)) {
      this.session.breakpoints.set(absolutePath, []);
    }

    return {
      success: true,
      filePath: absolutePath,
      metadata: {
        format: result.format,
        domain: result.domain,
        source: result.source,
        url: result.url,
        registers: result.registers,
        instructionCount: result.instructions.length,
        constantCount: result.constants.length,
      },
    };
  }

  /**
   * Load vmasm content directly (without reading from file)
   * Useful for testing
   *
   * @param content - Vmasm content string
   * @param virtualPath - Virtual path to use as key
   * @returns LoadResult on success, LoadError on failure
   */
  loadContent(content: string, virtualPath: string): LoadResult | LoadError {
    const result = parseVmasm(content);
    if (isParseError(result)) {
      return {
        success: false,
        error: `Parse error at line ${result.line ?? 'unknown'}: ${result.message}`,
        parseError: result,
      };
    }

    this.session.loadedFiles.set(virtualPath, result);

    if (!this.session.activeFile) {
      this.session.activeFile = virtualPath;
    }

    if (!this.session.breakpoints.has(virtualPath)) {
      this.session.breakpoints.set(virtualPath, []);
    }

    return {
      success: true,
      filePath: virtualPath,
      metadata: {
        format: result.format,
        domain: result.domain,
        source: result.source,
        url: result.url,
        registers: result.registers,
        instructionCount: result.instructions.length,
        constantCount: result.constants.length,
      },
    };
  }

  /**
   * Get the currently active AST
   */
  getActiveAST(): VmasmAST | undefined {
    if (!this.session.activeFile) {
      return undefined;
    }
    return this.session.loadedFiles.get(this.session.activeFile);
  }

  /**
   * Get AST for a specific file
   */
  getAST(filePath: string): VmasmAST | undefined {
    return this.session.loadedFiles.get(filePath);
  }

  /**
   * Set the active vmasm file
   */
  setActiveFile(filePath: string): boolean {
    if (!this.session.loadedFiles.has(filePath)) {
      return false;
    }
    this.session.activeFile = filePath;
    return true;
  }

  /**
   * Get the active file path
   */
  getActiveFilePath(): string | undefined {
    return this.session.activeFile;
  }

  /**
   * Get all loaded file paths
   */
  getLoadedFiles(): string[] {
    return Array.from(this.session.loadedFiles.keys());
  }

  /**
   * Check if a file is loaded
   */
  isFileLoaded(filePath: string): boolean {
    return this.session.loadedFiles.has(filePath);
  }

  // ==========================================
  // Address Mapping Queries
  // ==========================================

  /**
   * Get register mapping from the active file
   */
  getRegisterMapping(): RegisterMapping | undefined {
    const ast = this.getActiveAST();
    return ast?.registers;
  }

  /**
   * Get bytecode address from line number
   */
  getAddressFromLine(line: number): number | undefined {
    const ast = this.getActiveAST();
    return ast?.lineToAddr.get(line);
  }

  /**
   * Get line number from bytecode address
   */
  getLineFromAddress(addr: number): number | undefined {
    const ast = this.getActiveAST();
    return ast?.addrToLine.get(addr);
  }

  /**
   * Get instruction at a specific address
   */
  getInstructionAtAddress(addr: number): InstructionEntry | undefined {
    const ast = this.getActiveAST();
    if (!ast) return undefined;
    return ast.instructions.find(instr => instr.addr === addr);
  }

  /**
   * Check if an address is valid (exists in the vmasm file)
   */
  isValidAddress(addr: number): boolean {
    const ast = this.getActiveAST();
    if (!ast) return false;
    return ast.addrToLine.has(addr);
  }

  /**
   * Get all valid addresses from the active file
   */
  getValidAddresses(): number[] {
    const ast = this.getActiveAST();
    if (!ast) return [];
    return Array.from(ast.addrToLine.keys()).sort((a, b) => a - b);
  }

  // ==========================================
  // Breakpoint Management
  // Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
  // ==========================================

  /**
   * Generate a unique breakpoint ID
   */
  private generateBreakpointId(): string {
    return `vmasm-bp-${++this.session.breakpointIdCounter}`;
  }

  /**
   * Set a breakpoint at a bytecode address
   * Requirements: 3.1, 3.2, 3.6
   *
   * @param address - Bytecode address
   * @param condition - Optional condition expression
   * @returns Breakpoint info or error
   */
  setBreakpoint(
    address: number,
    condition?: string
  ): VmasmBreakpoint | {error: string} {
    const activeFile = this.session.activeFile;
    if (!activeFile) {
      return {error: 'No vmasm file loaded'};
    }

    // Validate address
    if (!this.isValidAddress(address)) {
      const validAddresses = this.getValidAddresses();
      const addressRange =
        validAddresses.length > 0
          ? `Valid range: 0x${validAddresses[0].toString(16).padStart(4, '0')} - 0x${validAddresses[validAddresses.length - 1].toString(16).padStart(4, '0')}`
          : 'No valid addresses';
      return {
        error: `Invalid address 0x${address.toString(16).padStart(4, '0')}. ${addressRange}`,
      };
    }

    // Check if breakpoint already exists at this address
    const existingBreakpoints = this.session.breakpoints.get(activeFile) || [];
    const existing = existingBreakpoints.find(bp => bp.address === address);
    if (existing) {
      return existing;
    }

    // Create new breakpoint
    const breakpoint: VmasmBreakpoint = {
      id: this.generateBreakpointId(),
      address,
      condition,
      vmasmPath: activeFile,
      hitCount: 0,
    };

    existingBreakpoints.push(breakpoint);
    this.session.breakpoints.set(activeFile, existingBreakpoints);

    return breakpoint;
  }

  /**
   * List all breakpoints for the active file
   * Requirements: 3.4
   */
  listBreakpoints(): VmasmBreakpoint[] {
    const activeFile = this.session.activeFile;
    if (!activeFile) {
      return [];
    }
    return this.session.breakpoints.get(activeFile) || [];
  }

  /**
   * List all breakpoints across all files
   */
  listAllBreakpoints(): VmasmBreakpoint[] {
    const allBreakpoints: VmasmBreakpoint[] = [];
    for (const breakpoints of this.session.breakpoints.values()) {
      allBreakpoints.push(...breakpoints);
    }
    return allBreakpoints;
  }

  /**
   * Get a breakpoint by ID
   */
  getBreakpointById(id: string): VmasmBreakpoint | undefined {
    for (const breakpoints of this.session.breakpoints.values()) {
      const bp = breakpoints.find(b => b.id === id);
      if (bp) return bp;
    }
    return undefined;
  }

  /**
   * Remove a breakpoint by ID
   * Requirements: 3.3
   *
   * @param id - Breakpoint ID
   * @returns true if removed, false if not found
   */
  removeBreakpoint(id: string): boolean {
    for (const [filePath, breakpoints] of this.session.breakpoints.entries()) {
      const index = breakpoints.findIndex(bp => bp.id === id);
      if (index !== -1) {
        breakpoints.splice(index, 1);
        this.session.breakpoints.set(filePath, breakpoints);
        return true;
      }
    }
    return false;
  }

  /**
   * Clear all breakpoints for the active file
   * Requirements: 3.5
   */
  clearBreakpoints(): number {
    const activeFile = this.session.activeFile;
    if (!activeFile) {
      return 0;
    }
    const breakpoints = this.session.breakpoints.get(activeFile) || [];
    const count = breakpoints.length;
    this.session.breakpoints.set(activeFile, []);
    return count;
  }

  /**
   * Clear all breakpoints across all files
   */
  clearAllBreakpoints(): number {
    let count = 0;
    for (const breakpoints of this.session.breakpoints.values()) {
      count += breakpoints.length;
    }
    this.session.breakpoints.clear();
    return count;
  }

  /**
   * Update CDP breakpoint ID for a breakpoint
   */
  updateBreakpointCdpId(id: string, cdpBreakpointId: string): boolean {
    const bp = this.getBreakpointById(id);
    if (bp) {
      bp.cdpBreakpointId = cdpBreakpointId;
      return true;
    }
    return false;
  }

  /**
   * Increment hit count for a breakpoint
   */
  incrementBreakpointHitCount(id: string): void {
    const bp = this.getBreakpointById(id);
    if (bp) {
      bp.hitCount++;
    }
  }

  // ==========================================
  // Interception Configuration
  // Requirements: 8.4
  // ==========================================

  /**
   * Set interception configuration for a vmasm file
   */
  setInterceptionConfig(
    vmasmPath: string,
    config: InterceptionConfig
  ): void {
    this.session.interceptionConfigs.set(vmasmPath, config);
  }

  /**
   * Get interception configuration for a vmasm file
   */
  getInterceptionConfig(vmasmPath: string): InterceptionConfig | undefined {
    return this.session.interceptionConfigs.get(vmasmPath);
  }

  /**
   * Get all interception configurations
   */
  getAllInterceptionConfigs(): Map<string, InterceptionConfig> {
    return new Map(this.session.interceptionConfigs);
  }

  /**
   * Remove interception configuration
   */
  removeInterceptionConfig(vmasmPath: string): boolean {
    return this.session.interceptionConfigs.delete(vmasmPath);
  }

  // ==========================================
  // Session Management
  // ==========================================

  /**
   * Reset the session to initial state
   */
  reset(): void {
    this.session = {
      loadedFiles: new Map(),
      breakpoints: new Map(),
      interceptionConfigs: new Map(),
      breakpointIdCounter: 0,
    };
  }

  /**
   * Get session statistics
   */
  getSessionStats(): {
    loadedFileCount: number;
    totalBreakpoints: number;
    activeFile: string | undefined;
  } {
    return {
      loadedFileCount: this.session.loadedFiles.size,
      totalBreakpoints: this.listAllBreakpoints().length,
      activeFile: this.session.activeFile,
    };
  }
}

// ==========================================
// Singleton Instance
// ==========================================

/**
 * Global vmasm context instance
 * Used across the MCP server for session management
 */
let globalVmasmContext: VmasmContext | null = null;

/**
 * Get the global vmasm context instance
 * Creates a new instance if one doesn't exist
 */
export function getVmasmContext(): VmasmContext {
  if (!globalVmasmContext) {
    globalVmasmContext = new VmasmContext();
  }
  return globalVmasmContext;
}

/**
 * Reset the global vmasm context
 * Useful for testing
 */
export function resetVmasmContext(): void {
  if (globalVmasmContext) {
    globalVmasmContext.reset();
  }
  globalVmasmContext = null;
}
