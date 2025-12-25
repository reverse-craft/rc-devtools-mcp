/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {minify} from 'terser';

const BUILD_DIR = path.join(process.cwd(), 'build');

/**
 * Recursively finds all JavaScript files in a directory.
 */
function findJsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, {withFileTypes: true});

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Minifies a JavaScript file.
 */
async function minifyFile(filePath: string): Promise<void> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const result = await minify(content, {
    module: true,
    compress: {
      drop_console: false,
      drop_debugger: true,
    },
    format: {
      comments: /Copyright|@license|@preserve/i,
    },
    sourceMap: false,
  });

  if (result.code) {
    fs.writeFileSync(filePath, result.code, 'utf-8');
  }
}

async function main(): Promise<void> {
  const srcDir = path.join(BUILD_DIR, 'src');
  if (!fs.existsSync(srcDir)) {
    console.error(`Build directory not found: ${srcDir}`);
    process.exit(1);
  }

  const jsFiles = findJsFiles(srcDir);
  console.log(`Found ${jsFiles.length} JavaScript files to minify...`);

  for (const file of jsFiles) {
    try {
      await minifyFile(file);
      console.log(`Minified: ${path.relative(BUILD_DIR, file)}`);
    } catch (error) {
      console.error(`Error minifying ${file}:`, error);
      process.exit(1);
    }
  }

  console.log('Minification complete!');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
