/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for README legacy name validation.
 * 
 * Feature: rc-devtools-rebuild
 * Property 3: README 无遗留名称引用
 * Validates: Requirements 5.8
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Legacy project names that should not appear in README
const LEGACY_NAMES = [
  'chrome-devtools-mcp',
  'browser-debugger-mcp',
  'Google LLC',
];

describe('README Legacy Names', () => {
  const readmePath = path.resolve(__dirname, '../../README.md');
  const readmeContent = fs.readFileSync(readmePath, 'utf-8');

  /**
   * Property 3: README 无遗留名称引用
   * For any legacy project name from the list,
   * the README should not contain that name.
   * 
   * Validates: Requirements 5.8
   */
  it('Property 3: README contains no legacy project names', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LEGACY_NAMES),
        (legacyName) => {
          return !readmeContent.includes(legacyName);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('README does not contain "chrome-devtools-mcp" (Requirement 5.8)', () => {
    assert.ok(
      !readmeContent.includes('chrome-devtools-mcp'),
      'README should not contain "chrome-devtools-mcp"'
    );
  });

  it('README does not contain "browser-debugger-mcp" (Requirement 5.8)', () => {
    assert.ok(
      !readmeContent.includes('browser-debugger-mcp'),
      'README should not contain "browser-debugger-mcp"'
    );
  });

  it('README does not contain "Google LLC" (Requirement 5.8)', () => {
    assert.ok(
      !readmeContent.includes('Google LLC'),
      'README should not contain "Google LLC"'
    );
  });
});
