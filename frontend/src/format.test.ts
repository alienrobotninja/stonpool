import { formatAmount } from "./format";

test("formats base units to token amounts", () => {
  expect(formatAmount(5_000_000)).toBe("5");
  expect(formatAmount(1_500_000)).toBe("1.5");
  expect(formatAmount(0)).toBe("0");
  expect(formatAmount(1_000_000_000)).toBe("1,000");
});