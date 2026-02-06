import dotenv from 'dotenv';
import { Client } from 'pg';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

client.connect().then(async () => {
  const { rows } = await client.query('SELECT session_id, status, lease_owner, lease_expires_at, updated_at FROM auth_state ORDER BY updated_at DESC');
  console.log('📊 Database auth_state lease status:');
  rows.forEach(row => {
    console.log(`Session: ${row.session_id}`);
    console.log(`  Status: ${row.status}`);
    console.log(`  Lease Owner: ${row.lease_owner || 'none'}`);
    console.log(`  Lease Expires: ${row.lease_expires_at || 'none'}`);
    console.log(`  Updated: ${row.updated_at}`);
    console.log('');
  });
  await client.end();
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
