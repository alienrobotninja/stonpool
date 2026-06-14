import { formatAmount, formatCountdown, parseAmount, shortAddress } from "./format";

test("formats base units to token amounts", () => {
  expect(formatAmount(5_000_000)).toBe("5");
  expect(formatAmount(1_500_000)).toBe("1.5");
  expect(formatAmount(0)).toBe("0");
  expect(formatAmount(1_000_000_000)).toBe("1,000");
});

test("formats a countdown", () => {
  expect(formatCountdown(90000, 0)).toBe("1d 1h");
  expect(formatCountdown(3700, 0)).toBe("1h 1m");
  expect(formatCountdown(120, 0)).toBe("2m");
  expect(formatCountdown(0, 10)).toBe("Closed");
});

test("parseAmount converts decimals to base units", () => {
  expect(parseAmount("10.5")).toBe(10_500_000n);
  expect(parseAmount("100")).toBe(100_000_000n);
  expect(parseAmount("0.000001")).toBe(1n);
  expect(parseAmount("0")).toBe(0n);
});

test("parseAmount rejects malformed input", () => {
  expect(() => parseAmount("abc")).toThrow();
  expect(() => parseAmount("1.2.3")).toThrow();
  expect(() => parseAmount("")).toThrow();
});

test("shortAddress truncates long addresses", () => {
  const raw = "0:" + "ab".repeat(32);
  expect(shortAddress(raw)).toBe("0:abab\u2026abab");
  expect(shortAddress("short")).toBe("short");
});