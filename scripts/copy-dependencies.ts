/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const BUILD_DIR = path.join(process.cwd(), 'build');

/**
 * Copy dependencies to build/node_modules for standalone deployment.
 * Only copies packages listed in dependencies (not devDependencies).
 */
function copyDependencies(): void {
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

copyDependencies();
