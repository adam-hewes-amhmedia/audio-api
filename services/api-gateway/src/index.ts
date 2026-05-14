import { startTelemetry } from "@audio-api/node-common";
import { buildServer } from "./server.js";

startTelemetry("api-gateway");

const port = Number(process.env.API_PORT ?? 8080);
buildServer().then(app => app.listen({ port, host: "0.0.0.0" }))
  .then(addr => console.log(`api-gateway listening on ${addr}`))
  .catch(e => { console.error(e); process.exit(1); });
