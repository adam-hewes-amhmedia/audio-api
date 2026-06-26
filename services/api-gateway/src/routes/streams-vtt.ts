import { FastifyInstance } from "fastify";
import { getPool, createStorage, getObjectStream } from "@audio-api/node-common";

// Serves the live rolling WebVTT (playlist + segments) and the final EBU-TT-D
// archive through the gateway, under the same bearer auth as the rest of the
// API. Objects live in a private bucket; nothing is publicly reachable.
export async function streamsVttRoutes(app: FastifyInstance) {
  const s3 = createStorage();

  async function tenantStream(id: string, tenant: string | undefined) {
    return getPool().query<{ id: string; status: string; ttml_object: string | null }>(
      "SELECT id, status, ttml_object FROM streams WHERE id = $1 AND tenant_id = $2",
      [id, tenant]
    );
  }

  function notFound(reply: any, message = "Stream not found") {
    return reply.code(404).send({ code: "STREAM_NOT_FOUND", message });
  }

  async function pipeObject(reply: any, key: string, contentType: string, cacheControl?: string) {
    try {
      const stream = await getObjectStream(s3, key);
      reply.header("content-type", contentType);
      if (cacheControl) reply.header("cache-control", cacheControl);
      return reply.send(stream);
    } catch {
      return notFound(reply, "Object not available");
    }
  }

  // GET /v1/streams/:id/captions.vtt — rolling live playlist
  app.get<{ Params: { id: string } }>(
    "/v1/streams/:id/captions.vtt",
    { onRequest: app.requireAuth },
    async (req, reply) => {
      const r = await tenantStream(req.params.id, req.tenant_id);
      if (r.rowCount === 0) return notFound(reply);
      // Short TTL so HLS players pick up new segments as they appear.
      return pipeObject(reply, `streams/${req.params.id}/playlist.vtt`, "text/vtt", "max-age=2");
    }
  );

  // GET /v1/streams/:id/segments/:seg — a rolling WebVTT segment
  app.get<{ Params: { id: string; seg: string } }>(
    "/v1/streams/:id/segments/:seg",
    { onRequest: app.requireAuth },
    async (req, reply) => {
      if (!/^[0-9A-Za-z._-]+\.vtt$/.test(req.params.seg)) return notFound(reply);
      const r = await tenantStream(req.params.id, req.tenant_id);
      if (r.rowCount === 0) return notFound(reply);
      return pipeObject(reply, `streams/${req.params.id}/segments/${req.params.seg}`, "text/vtt", "max-age=60");
    }
  );

  // GET /v1/streams/:id/captions.ttml — final EBU-TT-D archive (404 until archived)
  app.get<{ Params: { id: string } }>(
    "/v1/streams/:id/captions.ttml",
    { onRequest: app.requireAuth },
    async (req, reply) => {
      const r = await tenantStream(req.params.id, req.tenant_id);
      if (r.rowCount === 0) return notFound(reply);
      const row = r.rows[0];
      if (row.status !== "archived" || !row.ttml_object) {
        return notFound(reply, "Archive not ready");
      }
      return pipeObject(reply, row.ttml_object, "application/ttml+xml");
    }
  );
}
