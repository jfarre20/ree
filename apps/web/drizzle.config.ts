import type { Config } from "drizzle-kit";

export default {
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATA_DIR
      ? `${process.env.DATA_DIR}/reestreamer.db`
      : "./data/reestreamer.db",
  },
} satisfies Config;
