import { initDb } from '$lib/server/db';

// Run database initialization once when server starts
initDb().catch((err) => {
  console.error('Database auto-initialization failed on startup:', err);
});

export async function handle({ event, resolve }) {
  const response = await resolve(event);
  return response;
}
