import { defineConfig } from 'drizzle-kit'

// One config for both dialects: the scheme of DATABASE_URL picks schema file and output folder.
//   DATABASE_URL=sqlite::memory: bunx drizzle-kit generate
//   DATABASE_URL=postgres://x bunx drizzle-kit generate
const url = process.env.DATABASE_URL ?? 'sqlite:./data/octohatchery.db'
const isPg = /^postgres(ql)?:/.test(url)

export default defineConfig(
  isPg
    ? { dialect: 'postgresql', schema: './src/db/schema.pg.ts', out: './src/db/migrations/postgres' }
    : { dialect: 'sqlite', schema: './src/db/schema.ts', out: './src/db/migrations/sqlite' },
)
