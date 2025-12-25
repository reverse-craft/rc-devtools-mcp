/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import {nodeResolve} from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import cleanup from 'rollup-plugin-cleanup';
import license from 'rollup-plugin-license';

const isProduction = process.env.NODE_ENV === 'production';

const allowedLicenses = [
  'MIT',
  'Apache 2.0',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
  'ISC',
  '0BSD',
];

/**
 * @param {string} wrapperIndexPath
 * @param {import('rollup').OutputOptions} [extraOutputOptions={}]
 * @param {import('rollup').ExternalOption} [external=[]]
 * @returns {import('rollup').RollupOptions}
 */
const bundleDependency = (
  wrapperIndexPath,
  extraOutputOptions = {},
  external = [],
) => ({
  input: wrapperIndexPath,
  output: {
    ...extraOutputOptions,
    file: wrapperIndexPath,
    sourcemap: !isProduction,
    format: 'esm',
  },
  plugins: [
    cleanup({
      comments: [/Copyright|@license/i],
    }),
    license({
      thirdParty: {
        allow: {
          test: dependency => {
            return allowedLicenses.includes(dependency.license);
          },
          failOnUnlicensed: true,
          failOnViolation: true,
        },
        output: {
          file: path.join(
            path.dirname(wrapperIndexPath),
            'THIRD_PARTY_NOTICES',
          ),
          template(dependencies) {
            const stringifiedDependencies = dependencies.map(dependency => {
              let arr = [];
              arr.push(`Name: ${dependency.name ?? 'N/A'}`);
              let url = dependency.homepage ?? dependency.repository;
              if (url !== null && typeof url !== 'string') {
                url = url.url;
              }
              arr.push(`URL: ${url ?? 'N/A'}`);
              arr.push(`Version: ${dependency.version ?? 'N/A'}`);
              arr.push(`License: ${dependency.license ?? 'N/A'}`);
              if (dependency.licenseText !== null) {
                arr.push('');
                arr.push(dependency.licenseText.replaceAll('\r', ''));
              }
              return arr.join('\n');
            });

            // Manual license handling for chrome-devtools-frontend
            const tsConfig = JSON.parse(
              fs.readFileSync(
                path.join(process.cwd(), 'tsconfig.json'),
                'utf-8',
              ),
            );
            const thirdPartyDirectories = tsConfig.include.filter(location =>
              location.includes(
                'node_modules/chrome-devtools-frontend/front_end/third_party',
              ),
            );

            const manualLicenses = [];
            // Add chrome-devtools-frontend main license
            const cdtfLicensePath = path.join(
              process.cwd(),
              'node_modules/chrome-devtools-frontend/LICENSE',
            );
            if (fs.existsSync(cdtfLicensePath)) {
              manualLicenses.push(
                [
                  'Name: chrome-devtools-frontend',
                  'License: Apache-2.0',
                  '',
                  fs.readFileSync(cdtfLicensePath, 'utf-8'),
                ].join('\n'),
              );
            }

            for (const thirdPartyDir of thirdPartyDirectories) {
              const fullPath = path.join(process.cwd(), thirdPartyDir);
              const licenseFile = path.join(fullPath, 'LICENSE');
              if (fs.existsSync(licenseFile)) {
                const name = path.basename(thirdPartyDir);
                manualLicenses.push(
                  [
                    `Name: ${name}`,
                    `License:`,
                    '',
                    fs.readFileSync(licenseFile, 'utf-8').replaceAll('\r', ''),
                  ].join('\n'),
                );
              }
            }

            if (manualLicenses.length > 0) {
              stringifiedDependencies.push(...manualLicenses);
            }

            const divider =
              '\n\n-------------------- DEPENDENCY DIVIDER --------------------\n\n';
            return stringifiedDependencies.join(divider);
          },
        },
      },
    }),
    commonjs(),
    json(),
    nodeResolve(),
    ...(isProduction
      ? [
          terser({
            compress: {
              drop_console: false,
              drop_debugger: true,
            },
            format: {
              comments: /Copyright|@license/i,
            },
          }),
        ]
      : []),
  ],
  external,
});

export default [
  bundleDependency(
    './build/src/third-party/index.js',
    {
      inlineDynamicImports: true,
    },
    (source, importer, _isResolved) => {
      if (
        source === 'yargs' &&
        importer &&
        importer.includes('puppeteer-core')
      ) {
        return true;
      }

      const existingExternals = ['./devtools.js', '../devtools.js'];
      if (existingExternals.includes(source)) {
        return true;
      }

      return false;
    },
  ),
];
