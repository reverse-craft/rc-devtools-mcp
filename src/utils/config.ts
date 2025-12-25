/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration for debugger performance tuning.
 * These options control the trade-off between detail and speed in debugger operations.
 */
export interface DebuggerConfig {
  /** Maximum properties to show per scope (default: 10) */
  maxPropertiesPerScope: number;
  /** Whether to skip scope variable inspection entirely (default: false) */
  skipScopeVariables: boolean;
  /** Whether to use object previews instead of full property retrieval (default: true) */
  useObjectPreviews: boolean;
  /** Maximum depth for nested object inspection (default: 1) */
  maxObjectDepth: number;
}

/**
 * Configuration values that can be customized via environment variables.
 * These control output limits to prevent context overflow in LLM responses.
 */
export interface McpConfig {
  /** Max response/request body size in characters (default: 10000) */
  maxBodySize: number;
  /** Default pagination size for list operations (default: 20) */
  defaultPageSize: number;
  /** Max snippet length for search results (default: 200) */
  maxSnippetLength: number;
  /** Max properties to display for debugger objects (default: 20) */
  maxProperties: number;
  /** Max string length to display inline in debugger (default: 200) */
  maxInlineStringLength: number;
  /** Max URL length to display in request lists (default: 150) */
  maxUrlLength: number;
  /** Debugger performance tuning options */
  debugger: DebuggerConfig;
}

/**
 * Parse an integer from environment variable with a default fallback.
 */
function parseEnvInt(envVar: string | undefined, defaultValue: number): number {
  if (!envVar) return defaultValue;
  const parsed = parseInt(envVar, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

/**
 * Parse a boolean from environment variable with a default fallback.
 */
function parseEnvBool(envVar: string | undefined, defaultValue: boolean): boolean {
  if (!envVar) return defaultValue;
  return envVar.toLowerCase() === 'true';
}

/**
 * Get the current MCP configuration from environment variables.
 * Environment variables:
 * - MCP_MAX_BODY_SIZE: Max response/request body size (default: 10000)
 * - MCP_DEFAULT_PAGE_SIZE: Default pagination size (default: 20)
 * - MCP_MAX_SNIPPET_LENGTH: Max snippet length for search results (default: 200)
 * - MCP_MAX_PROPERTIES: Max properties for debugger (default: 20)
 * - MCP_MAX_INLINE_STRING_LENGTH: Max string length inline in debugger (default: 200)
 * - MCP_MAX_URL_LENGTH: Max URL length in request lists (default: 150)
 * - MCP_DEBUGGER_MAX_PROPERTIES_PER_SCOPE: Max properties per scope in debugger status (default: 10)
 * - MCP_DEBUGGER_SKIP_SCOPE_VARIABLES: Skip scope variable inspection (default: false)
 * - MCP_DEBUGGER_USE_OBJECT_PREVIEWS: Use object previews instead of full retrieval (default: true)
 * - MCP_DEBUGGER_MAX_OBJECT_DEPTH: Max depth for nested object inspection (default: 1)
 */
export function getConfig(): McpConfig {
  return {
    maxBodySize: parseEnvInt(process.env.MCP_MAX_BODY_SIZE, 10000),
    defaultPageSize: parseEnvInt(process.env.MCP_DEFAULT_PAGE_SIZE, 20),
    maxSnippetLength: parseEnvInt(process.env.MCP_MAX_SNIPPET_LENGTH, 200),
    maxProperties: parseEnvInt(process.env.MCP_MAX_PROPERTIES, 20),
    maxInlineStringLength: parseEnvInt(process.env.MCP_MAX_INLINE_STRING_LENGTH, 200),
    maxUrlLength: parseEnvInt(process.env.MCP_MAX_URL_LENGTH, 150),
    debugger: {
      maxPropertiesPerScope: parseEnvInt(process.env.MCP_DEBUGGER_MAX_PROPERTIES_PER_SCOPE, 10),
      skipScopeVariables: parseEnvBool(process.env.MCP_DEBUGGER_SKIP_SCOPE_VARIABLES, false),
      useObjectPreviews: parseEnvBool(process.env.MCP_DEBUGGER_USE_OBJECT_PREVIEWS, true),
      maxObjectDepth: parseEnvInt(process.env.MCP_DEBUGGER_MAX_OBJECT_DEPTH, 1),
    },
  };
}
