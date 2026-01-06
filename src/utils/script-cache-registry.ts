/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CDPSession } from 'puppeteer-core';
import { ScriptCacheManager } from './script-cache-manager.js';

/**
 * Global registry for managing ScriptCacheManager instances per CDP session.
 */
class ScriptCacheRegistryImpl {
  private managers: WeakMap<CDPSession, ScriptCacheManager> = new WeakMap();
  private sessionIds: WeakMap<CDPSession, string> = new WeakMap();
  private nextSessionId: number = 0;

  /**
   * Gets or creates a ScriptCacheManager for the given CDP session.
   */
  getOrCreate(session: CDPSession): ScriptCacheManager {
    let manager = this.managers.get(session);
    if (!manager) {
      // Generate a unique session ID
      const sessionId = `session-${this.nextSessionId++}`;
      this.sessionIds.set(session, sessionId);
      
      manager = new ScriptCacheManager(sessionId);
      this.managers.set(session, manager);
    }
    return manager;
  }

  /**
   * Gets the ScriptCacheManager for a session if it exists.
   */
  get(session: CDPSession): ScriptCacheManager | undefined {
    return this.managers.get(session);
  }

  /**
   * Removes and cleans up the ScriptCacheManager for a session.
   */
  async remove(session: CDPSession): Promise<void> {
    const manager = this.managers.get(session);
    if (manager) {
      await manager.cleanup();
      this.managers.delete(session);
      this.sessionIds.delete(session);
    }
  }

  /**
   * Cleans up all managers.
   * Note: This only works for sessions that are still referenced.
   * WeakMap entries for garbage-collected sessions are automatically removed.
   */
  async cleanupAll(): Promise<void> {
    // WeakMap doesn't support iteration, so we can't clean up all managers
    // This method is provided for API completeness but has limited functionality
    console.error(JSON.stringify({ level: 'warn', message: 'cleanupAll: WeakMap does not support iteration. Individual sessions should be cleaned up via remove().' }));
  }
}

/**
 * Singleton instance of the script cache registry.
 */
export const ScriptCacheRegistry = new ScriptCacheRegistryImpl();
