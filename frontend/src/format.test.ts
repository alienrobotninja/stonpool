import { formatAmount, formatCountdown } from "./format";

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