/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for file naming convention.
 * 
 * Feature: rc-devtools-rebuild
 * Property 2: 文件命名规范一致性
 * Validates: Requirements 4.5
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    } else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      fileList.push(filePath);
    }
  }
  
  return fileList;
}

// Check if a filename follows kebab-case convention
function isKebabCase(filename: string): boolean {
  // Remove .ts extension
  const nameWithoutExt = filename.replace(/\.ts$/, '');
  
  // kebab-case pattern: lowercase letters, numbers, and hyphens only
  // Must start with a letter, no consecutive hyphens, no trailing hyphen
  const kebabCasePattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  
  return kebabCasePattern.test(nameWithoutExt);
}

describe('File Naming Convention', () => {
  const srcDir = path.resolve(__dirname, '../../src');
  const allTsFiles = getAllTsFiles(srcDir);
  const fileNames = allTsFiles.map(f => path.basename(f));

  /**
   * Property 2: 文件命名规范一致性
   * For any TypeScript file in src/ directory,
   * the filename should follow kebab-case convention.
   * 
   * Validates: Requirements 4.5
   */
  it('Property 2: All src/ files follow kebab-case naming', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...fileNames),
        (filename) => {
          return isKebabCase(filename);
        }
      ),
      { numRuns: Math.min(100, fileNames.length) }
    );
  });

  it('All TypeScript files in src/ use kebab-case (Requirement 4.5)', () => {
    const violations: string[] = [];
    
    for (const file of allTsFiles) {
      const filename = path.basename(file);
      if (!isKebabCase(filename)) {
        violations.push(file);
      }
    }
    
    assert.strictEqual(
      violations.length,
      0,
      `Files not following kebab-case:\n${violations.join('\n')}`
    );
  });
});
