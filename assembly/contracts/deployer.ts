import {
  createSC,
  fileToByteArray,
  generateEvent,
  transferCoins,
  createEvent,
  Context,
  call,
  balance,
} from '@massalabs/massa-as-sdk';
import { Args } from '@massalabs/as-types';
import { IMyFloorToken } from '../interfaces/IMyFloorToken';
import { IERC20 } from '@dusalabs/core';
import { IFactory } from '@dusalabs/core';
import { Address } from '@massalabs/massa-as-sdk';

const ONE_COIN = u64(10 ** 9);

export function constructor(): void {
  // This is the deployer contract, so we don't need to do anything here
}

export function deploy(bs: StaticArray<u8>): void {
  // The caller pays for the whole deployment (storage, coins sent to the token, calls): the
  // deployer's own balance must not decrease, and whatever the caller sent in excess is refunded.
  const balanceBefore = balance() - Context.transferredCoins();

  const floorWasm: StaticArray<u8> = fileToByteArray('build/MyFloorToken.wasm');
  const myFloor = new IMyFloorToken(createSC(floorWasm));
  transferCoins(myFloor._origin, 11 * ONE_COIN); // 10 to create LB pair + 1 to pay fees

  const args = new Args(bs);

  // floor token args
  const tokenY = args.nextString().unwrap();
  const factory = args.nextString().unwrap();
  const activeId = args.nextU32().unwrap();
  const binStep = args.nextU32().unwrap();
  const floorPerBin = args.nextU256().unwrap();

  // transfer tax token args
  const name = args.nextString().unwrap();
  const symbol = args.nextString().unwrap();
  const decimals = args.nextU8().unwrap();
  const initialSupply = args.nextU256().unwrap();
  const taxRate = args.nextU256().unwrap();
  const taxRecipientBs = args.nextString();
  const taxRecipient = taxRecipientBs.isOk()
    ? new Address(taxRecipientBs.unwrap())
    : new Address('0');

  myFloor.init(
    new IERC20(new Address(tokenY)),
    new IFactory(new Address(factory)),
    activeId,
    binStep,
    floorPerBin,
    name,
    symbol,
    decimals,
    initialSupply,
    taxRate,
    taxRecipient,
    Context.caller(), // receives the initial supply (not this deployer)
  );

  call(
    myFloor._origin,
    'setOwner',
    new Args().add(Context.caller().toString()),
    0,
  );

  generateEvent(createEvent('NEW_FLOOR', [myFloor._origin.toString()]));

  const balanceAfter = balance();
  assert(
    balanceAfter >= balanceBefore,
    'not enough coins sent to pay for the deployment',
  );
  const refund = balanceAfter - balanceBefore;
  if (refund > 0) transferCoins(Context.caller(), refund);
}
