/**
 * Transform Parser - Parses @opcode_transform directives from vmasm files
 *
 * Ported from jsvmp-ir-extension for rc-devtools-mcp
 */

/**
 * Enhanced debug variable with pre/post classification
 */
export interface EnhancedDebugVariable {
  /** variable name (e.g., fn, args, result) */
  name: string;

  /** expression (e.g., stack[sp - argCount]) */
  expression: string;

  /** whether this is a post-execution expression */
  isPost: boolean;
}

/**
 * Parse a quoted expression string
 * Format: "[pre:|post:]varName = expression"
 *
 * @param input - The quoted expression string (with or without surrounding quotes)
 * @returns EnhancedDebugVariable if valid, null otherwise
 */
export function parseQuotedExpression(input: string): EnhancedDebugVariable | null {
  let content = input.trim();

  // Remove surrounding quotes if present
  if (content.startsWith('"') && content.endsWith('"')) {
    content = content.slice(1, -1);
  }

  // Handle escaped quotes within the content
  content = content.replace(/\\"/g, '"');

  // Check for pre:/post: prefix
  let isPost = false;
  if (content.startsWith('pre:')) {
    content = content.slice(4);
    isPost = false;
  } else if (content.startsWith('post:')) {
    content = content.slice(5);
    isPost = true;
  }
  // No prefix defaults to pre

  // Parse the assignment: varName = expression
  const assignmentMatch = content.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
  if (!assignmentMatch) {
    return null;
  }

  const [, name, expression] = assignmentMatch;

  return {
    name,
    expression: expression.trim(),
    isPost,
  };
}


/**
 * Split a string by semicolons, respecting quoted strings
 * Handles escaped quotes within quoted strings
 *
 * @param input - The input string to split
 * @returns Array of expression strings
 */
export function splitQuotedExpressions(input: string): string[] {
  const expressions: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (char === '\\' && i + 1 < input.length && input[i + 1] === '"') {
      // Escaped quote - include both characters
      current += '\\"';
      i += 2;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      i++;
      continue;
    }

    if (char === ';' && !inQuotes) {
      // End of expression
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        expressions.push(trimmed);
      }
      current = '';
      i++;
      continue;
    }

    current += char;
    i++;
  }

  // Don't forget the last expression
  const trimmed = current.trim();
  if (trimmed.length > 0) {
    expressions.push(trimmed);
  }

  return expressions;
}

/**
 * Check if a statements string uses the new quoted format
 *
 * @param statementsStr - The statements portion of the transform line
 * @returns true if using quoted format, false for old format
 */
export function isQuotedFormat(statementsStr: string): boolean {
  // New format starts with a quoted string
  return statementsStr.trim().startsWith('"');
}
