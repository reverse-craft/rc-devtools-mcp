/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Context Code Utilities for extracting and formatting code context
 * around breakpoint locations and search results.
 */

// ============================================================================
// Context Code Extraction Types
// ============================================================================

/**
 * Options for extracting context code around a specific location.
 */
export interface ContextCodeOptions {
  /** Current line number (1-based) */
  lineNumber: number;
  /** Current column number (0-based) */
  columnNumber: number;
  /** Number of context lines before and after current line (default: 5) */
  contextLines: number;
  /** Whether to format minified code for better readability */
  formatMinified: boolean;
  /** Maximum length of a single code line (default: 500) */
  maxLineLength?: number;
}

/**
 * Extended options for optimized context code extraction.
 * Includes performance-related options for faster extraction.
 */
export interface OptimizedContextOptions extends ContextCodeOptions {
  /** Pre-computed line offsets for O(1) line lookup */
  lineOffsets?: number[];
  /** Whether to skip formatting entirely (default: false) */
  skipFormatting?: boolean;
}

/**
 * Result of context code extraction.
 */
export interface ContextCodeResult {
  /** Formatted code lines with metadata */
  lines: FormattedLine[];
  /** Whether the code was formatted (minified code detected) */
  wasFormatted: boolean;
  /** Warning messages (e.g., AST parsing failures) */
  warnings: string[];
}

/**
 * A single formatted line of code with position information.
 */
export interface FormattedLine {
  /** Display line number (in formatted output) */
  displayLineNumber: number;
  /** Original line number in source (1-based) */
  originalLineNumber: number;
  /** Code content for this line */
  content: string;
  /** Whether this is the current execution line */
  isCurrentLine: boolean;
  /** Position annotations on this line */
  annotations: PositionAnnotation[];
}

/**
 * Position annotation for a specific code element.
 */
export interface PositionAnnotation {
  /** Original column number (0-based) */
  originalColumn: number;
  /** Formatted column number (0-based) */
  formattedColumn: number;
  /** Type of annotated element */
  type: 'function' | 'call' | 'statement' | 'breakpoint';
  /** Identifier name (e.g., function name) */
  name?: string;
}

// ============================================================================
// Minified Code Formatting Types
// ============================================================================

/**
 * Mapping between original and formatted positions.
 */
export interface PositionMapping {
  /** Original position in source */
  original: {line: number; column: number};
  /** Formatted position after AST formatting */
  formatted: {line: number; column: number};
}

/**
 * Result of formatting minified code.
 */
export interface FormatResult {
  /** Formatted code string */
  formattedCode: string;
  /** Position mappings from original to formatted */
  mappings: PositionMapping[];
  /** Whether formatting was successful */
  success: boolean;
  /** Error message if formatting failed */
  error?: string;
}

// ============================================================================
// Minified Code Detection
// ============================================================================

/** Threshold for average line length to consider code as minified */
const MINIFIED_AVG_LINE_LENGTH_THRESHOLD = 500;

/** Minimum code size to apply minification detection */
const MIN_CODE_SIZE_FOR_DETECTION = 100;

/**
 * Detect if JavaScript source code is minified.
 *
 * Minified code typically has:
 * - Very long lines (>500 chars average)
 * - Very few lines relative to code size
 * - Little to no whitespace/indentation
 *
 * @param source - The JavaScript source code to check
 * @returns true if the code appears to be minified
 */
export function isMinified(source: string): boolean {
  if (!source || source.length < MIN_CODE_SIZE_FOR_DETECTION) {
    return false;
  }

  const lines = source.split('\n');
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length === 0) {
    return false;
  }

  // Calculate average line length
  const totalLength = nonEmptyLines.reduce((sum, line) => sum + line.length, 0);
  const avgLineLength = totalLength / nonEmptyLines.length;

  // If average line length exceeds threshold, consider it minified
  if (avgLineLength > MINIFIED_AVG_LINE_LENGTH_THRESHOLD) {
    return true;
  }

  // Check ratio of code size to line count
  // Minified code typically has very few lines for its size
  const bytesPerLine = source.length / nonEmptyLines.length;
  if (bytesPerLine > MINIFIED_AVG_LINE_LENGTH_THRESHOLD && nonEmptyLines.length <= 5) {
    return true;
  }

  return false;
}

// ============================================================================
// Context Code Extraction
// ============================================================================

/**
 * Extract context code around a specific location in source code.
 * Handles both regular and minified code.
 *
 * @param source - The JavaScript source code
 * @param options - Extraction options (supports both ContextCodeOptions and OptimizedContextOptions)
 * @returns ContextCodeResult with formatted lines
 */
export function extractContextCode(
  source: string,
  options: ContextCodeOptions | OptimizedContextOptions
): ContextCodeResult {
  const {lineNumber, columnNumber, contextLines, formatMinified, maxLineLength = 500} = options;
  const warnings: string[] = [];

  // Early exit when contextLines is 0
  if (contextLines === 0) {
    return {
      lines: [],
      wasFormatted: false,
      warnings: [],
    };
  }

  if (!source || source.length === 0) {
    return {
      lines: [],
      wasFormatted: false,
      warnings: ['Script has no source content'],
    };
  }

  // Extract optimized options if available
  const optimizedOptions = options as OptimizedContextOptions;
  const precomputedLineOffsets = optimizedOptions.lineOffsets;

  // Formatting is disabled for performance - always use raw source
  // The formatMinified parameter is kept for backward compatibility but ignored
  void formatMinified; // Suppress unused variable warning

  // Use pre-computed line offsets for O(1) line lookup if available
  // Otherwise, build them for efficient line extraction
  const lineOffsets = precomputedLineOffsets || buildLineOffsets(source);
  const totalLines = lineOffsets.length;

  // Calculate start and end line indices (0-based)
  const startLineIdx = Math.max(0, lineNumber - 1 - contextLines);
  const endLineIdx = Math.min(totalLines - 1, lineNumber - 1 + contextLines);

  const lines: FormattedLine[] = [];

  // Extract only the needed lines using line offsets for O(1) lookup per line
  for (let i = startLineIdx; i <= endLineIdx; i++) {
    const displayLineNumber = i + 1;
    const isCurrentLine = displayLineNumber === lineNumber;

    // Extract line content using line offsets for O(1) lookup
    const lineStart = lineOffsets[i];
    // lineOffsets[i+1] points to the start of the next line (after the \n)
    // So lineOffsets[i+1] - 1 is the \n character, and we want to exclude it
    const lineEnd = i + 1 < lineOffsets.length ? lineOffsets[i + 1] - 1 : source.length;
    let content = source.slice(lineStart, lineEnd);

    // Truncate very long lines to avoid context overflow
    // Center the truncation on the columnNumber if it's the current line
    if (content.length > maxLineLength) {
      if (isCurrentLine) {
        const half = Math.floor(maxLineLength / 2);
        const start = Math.max(0, columnNumber - half);
        const end = Math.min(content.length, columnNumber + half);
        content =
          (start > 0 ? '... ' : '') +
          content.substring(start, end) +
          (end < content.length ? ' ...' : '');
      } else {
        // For other lines, just take the beginning
        content = content.substring(0, maxLineLength) + '... [truncated]';
      }
    }

    lines.push({
      displayLineNumber,
      originalLineNumber: displayLineNumber, // No formatting, so original = display
      content,
      isCurrentLine,
      annotations: [],
    });
  }

  return {
    lines,
    wasFormatted: false, // Formatting is disabled
    warnings,
  };
}

/**
 * Format context code result as a displayable string.
 * Includes line numbers, current line marker, and position annotations.
 *
 * @param result - The context code result
 * @param originalLine - Original line number (1-based)
 * @param originalColumn - Original column number (0-based)
 * @param scriptUrl - Optional script URL for display
 * @param functionName - Optional function name for display
 * @returns Formatted string for display
 */
export function formatContextCodeOutput(
  result: ContextCodeResult,
  originalLine: number,
  originalColumn: number,
  scriptUrl?: string,
  functionName?: string
): string {
  if (result.lines.length === 0) {
    if (result.warnings.length > 0) {
      return `⚠️ ${result.warnings.join(', ')}`;
    }
    return 'No context code available';
  }

  const output: string[] = [];

  // Header
  const frameInfo = functionName ? ` (${functionName})` : '';
  output.push(`📍 Code Context${frameInfo}:`);

  if (scriptUrl) {
    output.push(`   Script: ${scriptUrl}`);
  }

  output.push(`   Original position: line ${originalLine}, column ${originalColumn}`);

  // Check if source appears to be minified (for informational message)
  // We detect this by checking if any line is very long (>500 chars)
  const hasLongLines = result.lines.some(line => line.content.length > 500);
  if (hasLongLines) {
    output.push('   ℹ️ Code is from minified source');
  }

  // Warnings
  for (const warning of result.warnings) {
    output.push(`   ⚠️ ${warning}`);
  }

  output.push('');
  output.push('   ' + '─'.repeat(50));

  // Calculate line number width for alignment
  const maxLineNum = Math.max(...result.lines.map((l) => l.displayLineNumber));
  const lineNumWidth = String(maxLineNum).length;

  // Code lines
  for (const line of result.lines) {
    const marker = line.isCurrentLine ? '>>>' : '   ';
    const lineNum = String(line.displayLineNumber).padStart(lineNumWidth, ' ');
    const posAnnotation = `[L:${line.originalLineNumber},C:0]`;

    // Build the line with annotations
    let codeLine = `${marker}${lineNum}  │ ${line.content}`;

    // Add position annotation
    const padding = Math.max(0, 60 - codeLine.length);
    codeLine += ' '.repeat(padding) + posAnnotation;

    // Add current marker
    if (line.isCurrentLine) {
      codeLine += ' ◄ current';
    }

    output.push(codeLine);
  }

  output.push('   ' + '─'.repeat(50));

  // Current line breakpoint info
  const currentLine = result.lines.find((l) => l.isCurrentLine);
  if (currentLine) {
    output.push('');
    output.push('   💡 Current position:');
    output.push(`      • [L:${currentLine.originalLineNumber},C:${originalColumn}]`);
  }

  return output.join('\n');
}


/**
 * Format a position annotation as a string.
 * Uses the format [L:{line},C:{column}] as specified in requirements.
 *
 * @param line - Line number (1-based)
 * @param column - Column number (0-based)
 * @returns Formatted position string
 */
export function formatPositionAnnotation(line: number, column: number): string {
  return `[L:${line},C:${column}]`;
}


// ============================================================================
// Position Conversion Utilities
// ============================================================================

/**
 * Build an array of line offsets for efficient position conversion.
 * lineOffsets[i] is the starting character index of line i+1 (1-based line numbers).
 *
 * For example, for source "abc\ndef\nghi":
 * - lineOffsets[0] = 0 (line 1 starts at index 0)
 * - lineOffsets[1] = 4 (line 2 starts at index 4, after "abc\n")
 * - lineOffsets[2] = 8 (line 3 starts at index 8, after "abc\ndef\n")
 *
 * @param source - The source code string
 * @returns Array where lineOffsets[i] is the starting index of line i+1
 */
export function buildLineOffsets(source: string): number[] {
  const offsets: number[] = [0]; // Line 1 always starts at index 0

  if (!source) {
    return offsets;
  }

  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      // Next line starts at i + 1
      offsets.push(i + 1);
    }
  }

  return offsets;
}

/**
 * Convert line (1-based) and column (0-based) to absolute source index.
 *
 * @param source - The source code string
 * @param line - Line number (1-based)
 * @param column - Column number (0-based)
 * @param lineOffsets - Optional pre-computed line offsets for O(1) lookup
 * @returns Absolute source index
 */
export function lineColumnToIndex(
  source: string,
  line: number,
  column: number,
  lineOffsets?: number[]
): number {
  if (!source || line < 1) {
    return 0;
  }

  // Use pre-computed offsets if available (O(1) lookup)
  if (lineOffsets && lineOffsets.length > 0) {
    const lineIndex = line - 1; // Convert to 0-based index

    if (lineIndex >= lineOffsets.length) {
      // Line is beyond the source, return end of source
      return source.length;
    }

    const lineStart = lineOffsets[lineIndex];
    const index = lineStart + column;

    // Clamp to valid range
    return Math.min(index, source.length);
  }

  // Fall back to linear scan if lineOffsets not available
  let currentLine = 1;
  let lineStart = 0;

  for (let i = 0; i < source.length; i++) {
    if (currentLine === line) {
      // Found the target line, add column offset
      const index = lineStart + column;
      return Math.min(index, source.length);
    }

    if (source[i] === '\n') {
      currentLine++;
      lineStart = i + 1;
    }
  }

  // If we've scanned the whole source and reached the target line
  if (currentLine === line) {
    const index = lineStart + column;
    return Math.min(index, source.length);
  }

  // Line is beyond the source
  return source.length;
}
