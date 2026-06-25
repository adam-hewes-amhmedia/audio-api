import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The gateway tests run against one shared Postgres database and reuse
    // fixed fixture ids (e.g. api_tokens 't_test'). Each file's beforeAll
    // does DELETE-then-INSERT of that id, which only works if files run
    // serially. Without this, parallel files race and collide on the
    // api_tokens primary key. Keep file execution sequential.
    fileParallelism: false,
  },
});
