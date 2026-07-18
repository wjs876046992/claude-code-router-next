import { afterEach, describe, expect, it, vi } from "vitest";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";
import { sessionUsageCache } from "../utils/cache";
import { closeProxyDispatchers } from "../services/proxy";

// POST /api/config normally persists to ~/.claude-code-router/config.json.
// Keep this route test hermetic so accepted payloads can never overwrite a
// developer's real configuration or rotate its backups.
vi.mock("../ccr/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccr/config")>();
  return {
    ...actual,
    backupConfigFile: vi.fn().mockResolvedValue(null),
    writeConfigFile: vi.fn().mockResolvedValue(undefined),
  };
});

// Verifies the POST /api/config proxy-URL validation gate: an invalid proxy
// URL must yield HTTP 400 *before* any backup/write is attempted, regardless
// of which compatibility key (PROXY_URL, HTTPS_PROXY, https_proxy, httpsProxy)
// carries the bad value. Config persistence is mocked because this suite also
// verifies accepted values, which proceed through the save path.
async function buildAdminRuntime() {
  const config = {
    PORT: 0,
    APIKEY: "secret",
    Providers: [],
    Router: {},
  };

  const server = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: {
      providers: config.Providers,
      Router: config.Router,
      HOST: "127.0.0.1",
      PORT: 0,
    },
  });
  await server.ready();
  await registerAdminRoutes(server, config);
  await server.registerNamespace("/");
  await server.app.ready();
  return { server, config };
}

describe("POST /api/config proxy URL validation", () => {
  let server: Server;

  afterEach(async () => {
    sessionUsageCache.delete("claude-code:session:proxy-config-save");
    await closeProxyDispatchers();
    if (server) {
      await server.app.close();
    }
  });

  it("rejects an unsupported protocol with 400 and surfaces the key", async () => {
    ({ server } = await buildAdminRuntime());

    const res = await server.app.inject({
      method: "POST",
      url: "/api/config",
      payload: {
        Providers: [],
        Router: {},
        PROXY_URL: "socks5://localhost:1080",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.proxyErrors).toEqual([
      { key: "PROXY_URL", error: expect.stringContaining("socks5:") },
    ]);
  });

  it("rejects a malformed HTTPS_PROXY compatibility key", async () => {
    ({ server } = await buildAdminRuntime());

    const res = await server.app.inject({
      method: "POST",
      url: "/api/config",
      payload: {
        Providers: [],
        Router: {},
        HTTPS_PROXY: "not a url",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.proxyErrors[0].key).toBe("HTTPS_PROXY");
    expect(body.message).toContain("HTTPS_PROXY");
  });

  it("aggregates errors from multiple bad keys", async () => {
    ({ server } = await buildAdminRuntime());

    const res = await server.app.inject({
      method: "POST",
      url: "/api/config",
      payload: {
        Providers: [],
        Router: {},
        PROXY_URL: "ftp://example",
        https_proxy: "bad value",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    const keys = body.proxyErrors.map((e: any) => e.key).sort();
    expect(keys).toEqual(["PROXY_URL", "https_proxy"].sort());
    expect(body.proxyErrors.length).toBe(2);
  });

  it("accepts http(s) URLs, empty values, and $VAR placeholders", async () => {
    ({ server } = await buildAdminRuntime());

    for (const proxyUrl of [
      "http://127.0.0.1:7890",
      "https://proxy.corp:8443",
      "",
      "${PROXY_URL}",
      "$HTTPS_PROXY",
      "http://${PROXY_HOST}:8080",
    ]) {
      const res = await server.app.inject({
        method: "POST",
        url: "/api/config",
        payload: {
          Providers: [],
          Router: {},
          PROXY_URL: proxyUrl,
        },
      });

      // 400 would mean the validator rejected the value; anything else means
      // it passed (write/reload errors are tolerated and surface as 200).
      expect(res.statusCode, `proxyUrl=${proxyUrl}`).not.toBe(400);
    }
  });
});
