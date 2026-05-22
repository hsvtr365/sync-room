import pg from 'pg';
import { env } from '$env/dynamic/private';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL
});

export async function initDb() {
  console.log('Initializing PostgreSQL database schema in suji_db...');
  const client = await pool.connect();
  try {
    // Enable UUID extension
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    } catch (e) {
      console.log('uuid-ossp extension creation skipped/failed:', e);
    }
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    } catch (e) {
      console.log('pgcrypto extension creation skipped/failed:', e);
    }

    // 1. Create rooms table
    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        range_days INTEGER NOT NULL DEFAULT 7,
        time_start TEXT NOT NULL DEFAULT '08:00',
        time_end TEXT NOT NULL DEFAULT '24:00',
        display_unit TEXT NOT NULL DEFAULT '1hour',
        past_policy TEXT NOT NULL DEFAULT 'yesterday',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // 2. Create participants table
    await client.query(`
      CREATE TABLE IF NOT EXISTS participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID REFERENCES rooms(id) ON DELETE CASCADE NOT NULL,
        nickname TEXT NOT NULL,
        color TEXT NOT NULL,
        last_active_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // 3. Create unavailable_slots table
    await client.query(`
      CREATE TABLE IF NOT EXISTS unavailable_slots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID REFERENCES rooms(id) ON DELETE CASCADE NOT NULL,
        participant_id UUID REFERENCES participants(id) ON DELETE CASCADE NOT NULL,
        start_at TIMESTAMP WITH TIME ZONE NOT NULL,
        end_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // 4. Apply migrations/column updates
    await client.query(`
      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS host_id UUID;
    `);
    await client.query(`
      ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL;
    `);

    console.log('PostgreSQL database schema initialized successfully.');
  } catch (error) {
    console.error('Failed to initialize database schema:', error);
    throw error;
  } finally {
    client.release();
  }
}
