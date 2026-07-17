import { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { getPool } from "@audio-api/node-common";
import { audit } from "./audit.js";

// The live caption feed for the admin detail screen. The tenant API exposes the
// same pod WS at GET /v1/streams/:id/captions; the console cannot use that,
// because a Next route handler cannot proxy a WS upgrade and the admin token
// must stay server-side. SSE is a plain streaming HTTP response, so it passes
// through the Next proxy while the token never leaves the server.
//
// Cross-tenant on purpose (no tenant_id filter): admin sees every tenant, and
// the read is attributed to the admin token via the audit row below.
export async function adminCaptionsStreamRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/v1/admin/streams/:id/captions/stream",
    async (req, reply) => {
      const row = await getPool().query<{ host: string; port: number; tenant_id: string }>(
        `SELECT p.ws_host AS host, p.ws_port AS port, s.tenant_id AS tenant_id
         FROM streams s JOIN stream_pods p ON p.pod_id = s.pod_id
         WHERE s.id = $1 AND p.ws_port IS NOT NULL
           AND p.status IN ('ready', 'ingesting')`,
        [req.params.id]
      );

      // Everything from here is SSE. hijack() stops Fastify from also trying to
      // send a normal reply on this request.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const send = (obj: unknown) => {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
      };

      // Not live: tell the client and stop. The console falls back to the
      // finalised-cue history it already fetched.
      if (row.rowCount === 0) {
        send({ event: "error", code: "ADMIN_STREAM_NOT_LIVE" });
        res.end();
        return;
      }

      const { host, port, tenant_id } = row.rows[0];
      // Caption text is customer content; every read is attributable, exactly
      // as the polled cues endpoint audits stream.cues.view.
      await audit(req, "stream.captions.stream", "stream", req.params.id, tenant_id);

      const upstream = new WebSocket(`ws://${host}:${port}`);
      const ping = setInterval(() => {
        try { res.write(`: ping\n\n`); } catch {}
      }, 15000);

      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        clearInterval(ping);
        try { upstream.close(); } catch {}
        try { res.end(); } catch {}
      };

      upstream.on("message", (d) => {
        // Verbatim: d is already the { event, cue_id, ... } payload the console
        // consumes.
        try { res.write(`data: ${d.toString()}\n\n`); } catch {}
      });
      upstream.on("close", () => { send({ event: "closed" }); finish(); });
      upstream.on("error", () => { send({ event: "closed" }); finish(); });

      // Client hung up: close the pod WS so we do not leak the connection.
      res.on("close", () => { clearInterval(ping); try { upstream.close(); } catch {} });
    }
  );
}
