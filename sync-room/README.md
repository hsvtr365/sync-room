# sync-room

SvelteKit scheduling room app backed by PostgreSQL.

## Local development

```sh
npm install
cp .env.example .env
npm run dev
```

## Checks and build

```sh
npm run check
npm run build
```

## Production

Create a `.env` file with `DATABASE_URL`, then run:

```sh
./start.sh
```

To stop the app:

```sh
./stop.sh
```
