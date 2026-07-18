import { afterEach, describe, expect, it, vi } from "vitest";
import { checkOrigin, createAiClient } from "./aiClient";

const ORIGINAL_ENV = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  NETLIFY_DEV: process.env.NETLIFY_DEV,
  DISABLE_ORIGIN_CHECK: process.env.DISABLE_ORIGIN_CHECK,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.unstubAllGlobals();
}

function clearAiEnv() {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  vi.stubGlobal("Netlify", undefined);
}

describe("aiClient", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("无 DeepSeek key 且无 Netlify AI Gateway key 时不抛错", () => {
    clearAiEnv();

    expect(() => createAiClient()).not.toThrow();
    expect(createAiClient()).toBeNull();
  });

  it("允许生产域名和 tcamp14.cn 的常见来源", () => {
    process.env.NODE_ENV = "production";
    delete process.env.NETLIFY_DEV;
    delete process.env.DISABLE_ORIGIN_CHECK;
    vi.stubGlobal("Netlify", undefined);

    const origins = [
      "https://guileless-frangipane-912f61.netlify.app",
      "http://tcamp14.cn",
      "https://tcamp14.cn",
      "http://www.tcamp14.cn",
      "https://www.tcamp14.cn",
    ];

    for (const origin of origins) {
      const req = new Request("https://example.com/api/decompose", {
        headers: { origin },
      });
      expect(checkOrigin(req)).toBe(true);
    }
  });
});
