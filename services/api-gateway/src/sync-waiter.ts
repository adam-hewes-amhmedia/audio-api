import pg from "pg";

export async function waitForCompletion(jobId: string, timeoutMs: number): Promise<"completed" | "failed" | "timeout"> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("LISTEN job_done");

    const r = await client.query("SELECT status FROM jobs WHERE id=$1", [jobId]);
    if (r.rowCount && (r.rows[0].status === "completed" || r.rows[0].status === "failed")) {
      return r.rows[0].status;
    }

    return await new Promise<"completed" | "failed" | "timeout">(resolve => {
      const t = setTimeout(() => resolve("timeout"), timeoutMs);
      client.on("notification", async msg => {
        if (msg.payload === jobId) {
          clearTimeout(t);
          const r2 = await client.query("SELECT status FROM jobs WHERE id=$1", [jobId]);
          resolve(r2.rows[0]?.status === "failed" ? "failed" : "completed");
        }
      });
    });
  } finally {
    await client.end().catch(() => {});
  }
}
