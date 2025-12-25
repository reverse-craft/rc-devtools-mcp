/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Page} from '../third-party/index.js';

import {getCdpSession} from './cdp.js';

/**
 * Represents a persistent script entry registered with CDP.
 */
export interface PersistentScriptEntry {
  /** CDP-returned unique identifier for the script */
  identifier: string;
  /** User-provided optional name for easier management */
  name?: string;
  /** The full script source code */
  source: string;
  /** Timestamp when the script was registered */
  createdAt: number;
}

/**
 * WeakMap-based storage for per-page persistent script management.
 * Scripts are automatically cleaned up when the page is garbage collected.
 */
const pageScripts = new WeakMap<Page, Map<string, PersistentScriptEntry>>();

/**
 * Get or create the script map for a page.
 */
function getScriptMap(page: Page): Map<string, PersistentScriptEntry> {
  let scripts = pageScripts.get(page);
  if (!scripts) {
    scripts = new Map();
    pageScripts.set(page, scripts);
  }
  return scripts;
}

/**
 * Add a persistent script that executes on every page load.
 * Uses CDP Page.addScriptToEvaluateOnNewDocument to register the script.
 *
 * @param page - The page to register the script for
 * @param source - The JavaScript source code to execute
 * @param name - Optional name for easier identification
 * @returns The registered script entry with its identifier
 */
export async function addScript(
  page: Page,
  source: string,
  name?: string,
): Promise<PersistentScriptEntry> {
  const session = await getCdpSession(page);

  // Ensure Page domain is enabled (required for addScriptToEvaluateOnNewDocument)
  await session.send('Page.enable');

  // If the source looks like a function declaration (arrow function or regular function),
  // wrap it in an IIFE to ensure it executes
  let executableSource = source.trim();
  if (
    (executableSource.startsWith('(') && executableSource.includes('=>')) ||
    executableSource.startsWith('function') ||
    executableSource.startsWith('async function') ||
    executableSource.startsWith('async (')
  ) {
    // Check if it's already an IIFE (ends with () or ())
    if (!executableSource.endsWith('()') && !executableSource.endsWith('();')) {
      // Wrap in IIFE
      executableSource = `(${executableSource})()`;
    }
  }

  // Use CDP to register the script
  const result = await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: executableSource,
  });

  const entry: PersistentScriptEntry = {
    identifier: result.identifier,
    name,
    source,
    createdAt: Date.now(),
  };

  // Store in our registry
  const scripts = getScriptMap(page);
  scripts.set(entry.identifier, entry);

  return entry;
}

/**
 * Remove a persistent script by its identifier.
 * Uses CDP Page.removeScriptToEvaluateOnNewDocument to unregister the script.
 *
 * @param page - The page the script is registered for
 * @param identifier - The CDP identifier of the script to remove
 * @returns true if the script was found and removed, false otherwise
 */
export async function removeScript(
  page: Page,
  identifier: string,
): Promise<boolean> {
  const scripts = getScriptMap(page);

  // Check if the script exists in our registry
  if (!scripts.has(identifier)) {
    return false;
  }

  const session = await getCdpSession(page);

  // Use CDP to remove the script
  await session.send('Page.removeScriptToEvaluateOnNewDocument', {
    identifier,
  });

  // Remove from our registry
  scripts.delete(identifier);

  return true;
}

/**
 * List all registered persistent scripts for a page.
 *
 * @param page - The page to list scripts for
 * @returns Array of all registered script entries
 */
export function listScripts(page: Page): PersistentScriptEntry[] {
  const scripts = getScriptMap(page);
  return Array.from(scripts.values());
}

/**
 * Clear all persistent scripts for a page.
 * Removes all scripts from both CDP and the local registry.
 *
 * @param page - The page to clear scripts for
 * @returns The number of scripts that were removed
 */
export async function clearScripts(page: Page): Promise<number> {
  const scripts = getScriptMap(page);
  const count = scripts.size;

  if (count === 0) {
    return 0;
  }

  const session = await getCdpSession(page);

  // Remove all scripts from CDP
  const removePromises = Array.from(scripts.keys()).map(identifier =>
    session.send('Page.removeScriptToEvaluateOnNewDocument', {identifier}),
  );

  await Promise.all(removePromises);

  // Clear our registry
  scripts.clear();

  return count;
}

/**
 * Truncate script source to a preview length.
 *
 * @param source - The full script source
 * @param maxLength - Maximum length for the preview (default: 100)
 * @returns Truncated source with ellipsis if needed
 */
export function truncateSource(source: string, maxLength = 100): string {
  if (source.length <= maxLength) {
    return source;
  }
  return source.substring(0, maxLength) + '...';
}
