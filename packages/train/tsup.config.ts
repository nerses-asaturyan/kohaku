/* eslint-disable import/no-default-export */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
  external: [
    'viem',
    'ox',
    '@kohaku-eth/plugins',
    '@kohaku-eth/provider',
    '@kohaku-eth/railgun',
    '@train-protocol/sdk',
  ],
});
