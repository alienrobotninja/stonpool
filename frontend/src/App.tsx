import { Dapp } from "./Dapp";
import { TonProvider } from "./ton/provider";

export default function App() {
  return (
    <TonProvider>
      <Dapp />
    </TonProvider>
  );
}
