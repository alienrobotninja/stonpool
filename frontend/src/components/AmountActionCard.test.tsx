import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AmountActionCard } from "./AmountActionCard";

function setup(over: Partial<Parameters<typeof AmountActionCard>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onDone = vi.fn();
  render(
    <AmountActionCard
      title="Deposit"
      description="d"
      actionLabel="Go"
      connected
      onSubmit={onSubmit}
      onDone={onDone}
      {...over}
    />,
  );
  return { onSubmit, onDone };
}

test("disabled until connected", () => {
  setup({ connected: false });
  expect(screen.getByRole("button")).toBeDisabled();
});

test("rejects an invalid amount without submitting", () => {
  const { onSubmit } = setup();
  fireEvent.change(screen.getByPlaceholderText("0.0"), { target: { value: "abc" } });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(screen.getByText(/valid amount/i)).toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("submits the parsed base-unit amount and notifies onDone", async () => {
  const { onSubmit, onDone } = setup();
  fireEvent.change(screen.getByPlaceholderText("0.0"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(5_000_000n));
  await screen.findByText(/sent/i);
  expect(onDone).toHaveBeenCalledTimes(1);
});
