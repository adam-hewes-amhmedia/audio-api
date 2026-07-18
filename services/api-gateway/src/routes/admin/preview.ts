import { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { getPool } from "@audio-api/node-common";
import { audit } from "./audit.js";

// Browser-playable HLS video preview, proxied from the pod's HLS server. Same
// bridge shape as the captions SSE route: the browser reaches this same-origin
// via the Next proxy, and the pod is never exposed directly. Cross-tenant, and
// the playlist read is audited because it exposes customer video.
const SEGMENT_RE = /^seg-\d+\.ts$/;

async function podHls(id: string) {
  const row = await getPool().query<{ host: string; port: number; tenant_id: string }>(
    `SELECT p.ws_host AS host, p.hls_port AS port, s.tenant_id AS tenant_id
     FROM streams s JOIN stream_pods p ON p.pod_id = s.pod_id
     WHERE s.id = $1 AND p.hls_port IS NOT NULL
       AND p.status IN ('ready', 'ingesting')`,
    [id]
  );
  return row.rowCount ? row.rows[0] : null;
}

async function proxyFile(reply: FastifyReply, url: string, contentType: string) {
  let upstream: Response;
  try {
    upstream = await fetch(url, { cache: "no-store" });
  } catch {
    return reply.code(502).send({ code: "ADMIN_PREVIEW_UNREACHABLE", message: "Pod HLS server unreachable" });
  }
  if (!upstream.ok || !upstream.body) {
    return reply.code(404).send({ code: "ADMIN_PREVIEW_NOT_LIVE", message: "Preview not available yet" });
  }
  reply.header("content-type", contentType);
  reply.header("cache-control", "no-cache");
  return reply.send(Readable.fromWeb(upstream.body as any));
}

export async function adminPreviewRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/v1/admin/streams/:id/preview/index.m3u8",
    async (req, reply) => {
      const pod = await podHls(req.params.id);
      if (!pod) return reply.code(404).send({ code: "ADMIN_PREVIEW_NOT_LIVE", message: "No live preview for this stream" });
      await audit(req, "stream.preview.view", "stream", req.params.id, pod.tenant_id);
      return proxyFile(reply, `http://${pod.host}:${pod.port}/index.m3u8`, "application/vnd.apple.mpegurl");
    }
  );

  app.get<{ Params: { id: string; segment: string } }>(
    "/v1/admin/streams/:id/preview/:segment",
    async (req, reply) => {
      // Only real segment names reach the pod; nothing that could escape its dir.
      if (!SEGMENT_RE.test(req.params.segment)) {
        return reply.code(404).send({ code: "ADMIN_NOT_FOUND", message: "Unknown segment" });
      }
      const pod = await podHls(req.params.id);
      if (!pod) return reply.code(404).send({ code: "ADMIN_PREVIEW_NOT_LIVE", message: "No live preview for this stream" });
      return proxyFile(reply, `http://${pod.host}:${pod.port}/${req.params.segment}`, "video/mp2t");
    }
  );
}
