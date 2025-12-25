/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for code comments legacy reference validation.
 * 
 * Feature: rc-devtools-rebuild
 * Property 5: 代码注释无遗留项目引用
 * Validates: Requirements 4.6, 4.7, 4.8
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Legacy references that should not appear in source code
const LEGACY_REFERENCES = [
  'chrome-devtools-mcp',
  'browser-debugger-mcp',
  'Google LLC',
];

// Get all TypeScript files in src/ directory
function getAllTsFiles(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      // Skip node_modules and other non-source directories
      if (!file.startsWith('.') && file !== 'node_modules' && file !== 'build') {
        getAllTsFiles(filePath, fileList);
      }
    } else if (file.endsWith('.ts')) {
      fileList.push(filePath);
    }
  }
  
  return fileList;
}

describe('Code Comments Legacy References', () => {
  const srcDir = path.resolve(__dirname, '../../src');
  const allTsFiles = getAllTsFiles(srcDir);

  /**
   * Property 5: 代码注释无遗留项目引用
   * For any source file in src/ directory and any legacy reference,
   * the file should not contain that legacy reference.
   * 
   * Validates: Requirements 4.6, 4.7, 4.8
   */
  it('Property 5: No source files contain legacy project references', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allTsFiles),
        fc.constantFrom(...LEGACY_REFERENCES),
        (filePath, legacyRef) => {
          const content = fs.readFileSync(filePath, 'utf-8');
          return !content.includes(legacyRef);
        }
      ),
      { numRuns: Math.min(100, allTsFiles.length * LEGACY_REFERENCES.length) }
    );
  });

  it('No source files contain "chrome-devtools-mcp" (Requirements 4.6, 4.7)', () => {
    const violations: string[] = [];
    
    for (const file of allTsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('chrome-devtools-mcp')) {
        violations.push(file);
      }
    }
    
    assert.strictEqual(
      violations.length,
      0,
      `Files containing "chrome-devtools-mcp":\n${violations.join('\n')}`
    );
  });

  it('No source files contain "browser-debugger-mcp" (Requirements 4.6, 4.7)', () => {
    const violations: string[] = [];
    
    for (const file of allTsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('browser-debugger-mcp')) {
        violations.push(file);
      }
    }
    
    assert.strictEqual(
      violations.length,
      0,
      `Files containing "browser-debugger-mcp":\n${violations.join('\n')}`
    );
  });

  it('No source files contain "Google LLC" (Requirement 4.8)', () => {
    const violations: string[] = [];
    
    for (const file of allTsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('Google LLC')) {
        violations.push(file);
      }
    }
    
    assert.strictEqual(
      violations.length,
      0,
      `Files containing "Google LLC":\n${violations.join('\n')}`
    );
  });
});
