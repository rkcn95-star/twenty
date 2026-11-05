// Prints the SQL Better Auth needs for the options in src/auth.ts, for pasting into a core migration.
import pg from 'pg';
import { getMigrations } from 'better-auth/db/migration';
import { authOptions } from '../src/auth.js';

const pool = new pg.Pool({ connectionString: process.env.GENERATE_DATABASE_URL, options: '-c search_path=core' });
const { compileMigrations } = await getMigrations(
  authOptions({ pool, secret: 'x'.repeat(32), baseURL: 'http://localhost:3000', sendMail: async () => undefined }),
);
console.log(await compileMigrations());
await pool.end();
