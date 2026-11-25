import { defineConfig } from 'tsup';

// Production bundle for the Docker image (deploy/Dockerfile): API, worker, migrations runner and seed.
export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts', 'src/db/migrate.ts', 'src/db/seed.ts'],
  format: ['esm'], target: 'node22', platform: 'node', clean: true, sourcemap: true,
  noExternal: ['@dhruv/contracts'],
});
