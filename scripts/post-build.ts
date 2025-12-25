/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {sed} from './sed.ts';

const BUILD_DIR = path.join(process.cwd(), 'build');

/**
 * Writes content to a file.
 * @param filePath The path to the file.
 * @param content The content to write.
 */
function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8');
}

function main(): void {
  const devtoolsThirdPartyPath =
    'node_modules/chrome-devtools-frontend/front_end/third_party';
  const devtoolsFrontEndCorePath =
    'node_modules/chrome-devtools-frontend/front_end/core';

  // Create i18n mock
  const i18nDir = path.join(BUILD_DIR, devtoolsFrontEndCorePath, 'i18n');
  fs.mkdirSync(i18nDir, {recursive: true});
  const localesFile = path.join(i18nDir, 'locales.js');
  const localesContent = `
export const LOCALES = [
  'en-US',
];

export const BUNDLED_LOCALES = [
  'en-US',
];

export const DEFAULT_LOCALE = 'en-US';

export const REMOTE_FETCH_PATTERN = '@HOST@/remote/serve_file/@VERSION@/core/i18n/locales/@LOCALE@.json';

export const LOCAL_FETCH_PATTERN = './locales/@LOCALE@.json';`;
  writeFile(localesFile, localesContent);

  // Create codemirror.next mock.
  const codeMirrorDir = path.join(
    BUILD_DIR,
    devtoolsThirdPartyPath,
    'codemirror.next',
  );
  fs.mkdirSync(codeMirrorDir, {recursive: true});
  const codeMirrorFile = path.join(codeMirrorDir, 'codemirror.next.js');
  const codeMirrorContent = `export default {}`;
  writeFile(codeMirrorFile, codeMirrorContent);

  // Create root mock
  const rootDir = path.join(BUILD_DIR, devtoolsFrontEndCorePath, 'root');
  fs.mkdirSync(rootDir, {recursive: true});
  const runtimeFile = path.join(rootDir, 'Runtime.js');
  const runtimeContent = `
export function getChromeVersion() { return ''; };
export const hostConfig = {};
export const Runtime = {
  isDescriptorEnabled: () => true,
  queryParam: () => null,
}
export const experiments = {
  isEnabled: () => false,
}
  `;
  writeFile(runtimeFile, runtimeContent);

  copyDevToolsDescriptionFiles();
}

function copyDevToolsDescriptionFiles() {
  const devtoolsIssuesDescriptionPath =
    'node_modules/chrome-devtools-frontend/front_end/models/issues_manager/descriptions';
  const sourceDir = path.join(process.cwd(), devtoolsIssuesDescriptionPath);
  const destDir = path.join(
    BUILD_DIR,
    'src',
    'third_party',
    'issue-descriptions',
  );
  fs.cpSync(sourceDir, destDir, {recursive: true});
}

/**
 * Copy dependencies to build/node_modules for standalone deployment.
 * Only copies packages listed in dependencies (not devDependencies).
 */
function copyDependencies() {
  const sourceFile = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
  const dependencies = packageJson.dependencies || {};

  const buildNodeModulesDir = path.join(BUILD_DIR, 'node_modules');
  fs.mkdirSync(buildNodeModulesDir, {recursive: true});

  const sourceNodeModulesDir = path.join(process.cwd(), 'node_modules');

  for (const [depName] of Object.entries(dependencies)) {
    const sourceDepPath = path.join(sourceNodeModulesDir, depName);
    const destDepPath = path.join(buildNodeModulesDir, depName);

    if (fs.existsSync(sourceDepPath)) {
      fs.cpSync(sourceDepPath, destDepPath, {recursive: true});
      console.log(`Copied dependency: ${depName}`);
    } else {
      console.warn(`Warning: Dependency ${depName} not found in node_modules`);
    }
  }
}

/**
 * Copy package.json to build directory for standalone deployment.
 * Modifies paths to work from build directory.
 */
function copyPackageJson() {
  const sourceFile = path.join(process.cwd(), 'package.json');
  const destFile = path.join(BUILD_DIR, 'package.json');

  const packageJson = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));

  // Modify for standalone deployment from build directory
  packageJson.bin = './src/index.js';
  packageJson.main = './src/index.js';
  packageJson.files = ['src', 'node_modules', 'LICENSE'];

  // Remove devDependencies for production deployment
  delete packageJson.devDependencies;

  // Update scripts for build directory context
  packageJson.scripts = {
    start: 'node src/index.js',
  };

  fs.writeFileSync(destFile, JSON.stringify(packageJson, null, 2), 'utf-8');
}

main();
copyPackageJson();
copyDependencies();
