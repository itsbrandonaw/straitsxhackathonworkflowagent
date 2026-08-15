import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? "3001");
const host = process.env.HOST ?? "127.0.0.1";
const app = await buildApp();

await app.listen({ port, host });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
