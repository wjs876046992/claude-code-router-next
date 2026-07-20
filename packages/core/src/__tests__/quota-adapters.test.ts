import { describe, expect, it } from "vitest";
import { getQuotaAdapter } from "../services/quota-adapters";

// getQuotaAdapter dispatches purely by the provider baseUrl hostname. These
// tests pin the hostname routing so a provider's quota adapter is selected
// without making any network calls (queryQuota is not exercised here).

describe("getQuotaAdapter hostname dispatch", () => {
  it("routes Aliyun DashScope hostnames to a quota adapter", () => {
    expect(
      getQuotaAdapter("https://dashscope.aliyuncs.com/api/v1/services/aigc/...")
    ).not.toBeNull();
    expect(
      getQuotaAdapter("https://coding.dashscope.aliyuncs.com/v1/messages")
    ).not.toBeNull();
  });

  it("routes the Aliyun maas.aliyuncs.com token-plan gateway to a quota adapter", () => {
    // The Anthropic-compatible token-plan inference endpoint must resolve to the
    // same cookie-based Aliyun quota adapter so its 5h/7d limits are queryable.
    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    expect(adapter).not.toBeNull();
  });

  it("treats the maas token-plan and dashscope endpoints as the same adapter", () => {
    const maasAdapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const dashscopeAdapter = getQuotaAdapter(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/..."
    );
    // Same singleton instance -> both share the cookie-based Aliyun query path.
    expect(maasAdapter).toBe(dashscopeAdapter);
  });

  it("returns null for unknown hostnames", () => {
    expect(getQuotaAdapter("https://example.com/v1/messages")).toBeNull();
    expect(getQuotaAdapter("not-a-url")).toBeNull();
  });
});
