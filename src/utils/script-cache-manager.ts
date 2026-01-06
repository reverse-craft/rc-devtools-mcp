/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Entry for a cached script file.
 */
interface ScriptCacheEntry {
  scriptId: string;
  url: string;
  filePath: string;
}

/**
 * Manages script file caching for a single CDP session.
 * Scripts are cached to temporary files for ripgrep searching.
 */
export class ScriptCacheManager {
  readonly tempDir: string;
  private scriptIdToEntry: Map<string, ScriptCacheEntry> = new Map();
  private filePathToScriptId: Map<string, string> = new Map();
  private initialized: boolean = false;

  constructor(sessionId: string) {
    // Create a unique temp directory for this session
    this.tempDir = path.join(os.tmpdir(), `mcp-scripts-${sessionId}-${Date.now()}`);
  }

  /**
   * Ensures the temp directory exists.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      this.initialized = true;
    } catch (error) {
      // Log to stderr in JSON format for MCP compatibility
      console.error(JSON.stringify({ level: 'error', message: `Failed to create temp directory: ${error}` }));
      throw error;
    }
  }

  /**
   * Caches a script to a temporary file.
   * @param scriptId - The CDP script ID
   * @param url - The script URL
   * @param source - The script source code
   * @returns The file path where the script was cached, or undefined on failure
   */
  async cacheScript(scriptId: string, url: string, source: string): Promise<string | undefined> {
    await this.ensureInitialized();

    // Skip if already cached
    if (this.scriptIdToEntry.has(scriptId)) {
      return this.scriptIdToEntry.get(scriptId)!.filePath;
    }

    try {
      // Generate a safe filename from the URL
      const safeFilename = this.generateSafeFilename(scriptId, url);
      const filePath = path.join(this.tempDir, safeFilename);

      // Write the script source to the file
      await fs.writeFile(filePath, source, 'utf-8');

      // Store the mapping
      const entry: ScriptCacheEntry = { scriptId, url, filePath };
      this.scriptIdToEntry.set(scriptId, entry);
      this.filePathToScriptId.set(filePath, scriptId);

      return filePath;
    } catch (error) {
      // Log to stderr in JSON format for MCP compatibility
      console.error(JSON.stringify({ level: 'error', message: `Failed to cache script ${scriptId}: ${error}` }));
      return undefined;
    }
  }


  /**
   * Generates a safe filename for a script.
   */
  private generateSafeFilename(scriptId: string, url: string): string {
    // Extract filename from URL or use scriptId
    let filename = scriptId;
    try {
      if (url && url !== '') {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const basename = path.basename(pathname) || 'script';
        // Remove query strings and sanitize
        filename = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
      }
    } catch {
      // URL parsing failed, use scriptId
    }
    // Ensure unique filename by prepending scriptId
    return `${scriptId}_${filename}.js`;
  }

  /**
   * Gets the script ID from a file path.
   */
  getScriptIdFromFile(filePath: string): string | undefined {
    return this.filePathToScriptId.get(filePath);
  }

  /**
   * Gets the file path from a script ID.
   */
  getFileFromScriptId(scriptId: string): string | undefined {
    return this.scriptIdToEntry.get(scriptId)?.filePath;
  }

  /**
   * Gets the URL for a script ID.
   */
  getScriptUrl(scriptId: string): string | undefined {
    return this.scriptIdToEntry.get(scriptId)?.url;
  }

  /**
   * Gets all cached scripts.
   */
  getAllCachedScripts(): Map<string, { filePath: string; url: string }> {
    const result = new Map<string, { filePath: string; url: string }>();
    for (const [scriptId, entry] of this.scriptIdToEntry) {
      result.set(scriptId, { filePath: entry.filePath, url: entry.url });
    }
    return result;
  }

  /**
   * Gets the number of cached scripts.
   */
  getCachedScriptCount(): number {
    return this.scriptIdToEntry.size;
  }

  /**
   * Cleans up all cached files and the temp directory.
   */
  async cleanup(): Promise<void> {
    try {
      // Remove all cached files
      for (const entry of this.scriptIdToEntry.values()) {
        try {
          await fs.unlink(entry.filePath);
        } catch {
          // Ignore errors for individual files
        }
      }

      // Remove the temp directory
      if (this.initialized) {
        try {
          await fs.rmdir(this.tempDir);
        } catch {
          // Directory might not be empty or already removed
        }
      }

      // Clear the maps
      this.scriptIdToEntry.clear();
      this.filePathToScriptId.clear();
      this.initialized = false;
    } catch (error) {
      // Log to stderr in JSON format for MCP compatibility
      console.error(JSON.stringify({ level: 'error', message: `Failed to cleanup script cache: ${error}` }));
    }
  }
}
