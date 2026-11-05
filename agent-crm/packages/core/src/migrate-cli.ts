import pg from 'pg';
import { migrate } from './migrate.js';

const admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
console.log('applied', await migrate(admin));
await admin.end();
