import { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import WebSocket from "ws";
import { getPool } from "@audio-api/node-common";

export async function streamsWsRoutes(app: FastifyInstance) {
  await app.register(websocketPlugin);

  // GET /v1/streams/:id/captions — WebSocket proxy to pod's WS server
  app.get<{ Params: { id: string } }>(
    "/v1/streams/:id/captions",
    { websocket: true, onRequest: app.requireAuth },
    (socket, req) => {
      (async () => {
        const row = await getPool().query<{ host: string; port: number }>(
          `SELECT p.ws_host AS host, p.ws_port AS port
           FROM streams s JOIN stream_pods p ON p.pod_id = s.pod_id
           WHERE s.id = $1 AND s.tenant_id = $2 AND p.ws_port IS NOT NULL
             AND p.status IN ('ready', 'ingesting')`,
          [req.params.id, (req as any).tenant_id]
        );

        if (row.rowCount === 0) {
          try {
            socket.send(JSON.stringify({ event: "error", code: "STREAM_NOT_FOUND" }));
          } catch {}
          return socket.close();
        }

        const { host, port } = row.rows[0];
        const upstream = new WebSocket(`ws://${host}:${port}`);

        upstream.on("message", (d) => {
          try {
            socket.send(d.toString());
          } catch {}
        });

        upstream.on("close", () => {
          try {
            socket.close();
          } catch {}
        });

        upstream.on("error", () => {
          try {
            socket.close();
          } catch {}
        });

        socket.on("close", () => {
          try {
            upstream.close();
          } catch {}
        });
      })().catch(() => {
        try {
          socket.close();
        } catch {}
      });
    }
  );
}
