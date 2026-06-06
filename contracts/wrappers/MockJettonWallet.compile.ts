import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
  lang: 'tolk',
  entrypoint: 'contracts/mock-jetton/jetton-wallet.tolk',
};