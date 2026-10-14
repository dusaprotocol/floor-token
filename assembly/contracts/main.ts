import {
  Address,
  Context,
  createSC,
  fileToByteArray,
  generateEvent,
  transferCoins,
} from '@massalabs/massa-as-sdk';
import {
  IERC20,
  IFactory,
  ONE_COIN,
  PRECISION,
  SafeMath256,
  _sortTokens,
} from '@dusalabs/core';
import { u256 } from 'as-bignum/assembly/integer/u256';
import { IMyFloorToken } from '../interfaces/IMyFloorToken';

// script to deploy a FLOOR, raise roof and swap in a single transaction
// testing purposes only

export function constructor(bs: StaticArray<u8>): void {
  main(bs);
}

export function main(bs: StaticArray<u8>): void {
  generateEvent(Context.callee().toString());
  generateEvent(Context.caller().toString());

  const floorWasm: StaticArray<u8> = fileToByteArray('build/MyFloorToken.wasm');
  const floorToken = new IMyFloorToken(createSC(floorWasm));
  generateEvent(floorToken._origin.toString());
  transferCoins(floorToken._origin, 15 * ONE_COIN);

  const activeId = 8378237; // 1 with decimalsX = 18 and decimalsY = 9
  const binStep: u32 = 20;
  const floorPerBin = u256.mul(u256.from(100), u256.fromU64(10 ** 18));
  const tokenY = new IERC20(
    new Address('AS1LotSq7qVXma2L3EkiMjALtf9P8rCa6C4GkBhQQEYTovHQhZZY'),
  ); // WMAS
  const factory = new IFactory(
    new Address('AS12FnWgKKjv5ftKX8HsVETKVd9uUrdUPWfNhWig2ZqEt5u6UcGBA'),
  );

  const decimals: u8 = 18;
  const supply = u256.Zero;
  const taxRate = SafeMath256.div(
    SafeMath256.mul(u256.from(45), PRECISION),
    u256.from(1000),
  ); // 4.5%
  floorToken.init(
    tokenY,
    factory,
    activeId,
    binStep,
    floorPerBin,
    'My Floor Token',
    'FLOOR',
    decimals,
    supply,
    taxRate,
    new Address('0'),
    Context.caller(), // receives the initial supply
  );

  floorToken.floor.raiseRoof(10);
  floorToken.floor.raiseRoof(11);

  // const router = new IRouter(
  //   new Address('AS1hqJGuxDdhYFg7kA1syjsPzbSBY4BG94R75NzkVw3xmRBndY4M'),
  // );
  // const amountIn = u256.from(u64(300 * 10 ** tokenY.decimals()));
  // const amountOutMin = u256.One;
  // floorToken.transferTax.increaseAllowance(router._origin, amountIn);
  // tokenY.increaseAllowance(router._origin, amountIn);

  // router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
  //   amountIn,
  //   amountOutMin,
  //   [binStep],
  //   [tokenY, floorToken.transferTax],
  //   Context.caller(),
  //   Context.timestamp(),
  // );

  generateEvent(floorToken._origin.toString());
}
