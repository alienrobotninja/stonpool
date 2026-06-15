import { buildManifest, missingEnv, REQUIRED_ENV } from "./build-config";

describe("missingEnv", () => {
  it("flags unset and blank required keys", () => {
    expect(missingEnv({ VITE_API_BASE_URL: "https://api.x", VITE_POOL_CORE_ADDRESS: "0:ab", VITE_FAUCET_ADDRESS: "0:cd" })).toEqual([]);
    expect(missingEnv({ VITE_API_BASE_URL: "https://api.x" })).toEqual(["VITE_POOL_CORE_ADDRESS", "VITE_FAUCET_ADDRESS"]);
    expect(missingEnv({ VITE_API_BASE_URL: "  ", VITE_POOL_CORE_ADDRESS: "0:ab", VITE_FAUCET_ADDRESS: "0:cd" })).toEqual(["VITE_API_BASE_URL"]);
  });

  it("honours a custom required list", () => {
    expect(missingEnv({}, ["VITE_NETWORK"])).toEqual(["VITE_NETWORK"]);
    expect(REQUIRED_ENV).toContain("VITE_POOL_CORE_ADDRESS");
  });
});

describe("buildManifest", () => {
  it("derives a tonconnect manifest from the app origin", () => {
    expect(buildManifest("https://stonpool.pages.dev/")).toEqual({
      url: "https://stonpool.pages.dev",
      name: "STONPOOL",
      iconUrl: "https://stonpool.pages.dev/icon-180.png",
    });
  });
});