import { existsSync } from 'node:fs';

// Loads .env into process.env for the CLI entry points (server, seed, ingest).
// Variables that are already set in the environment win over the file.
if (existsSync('.env')) process.loadEnvFile('.env');
