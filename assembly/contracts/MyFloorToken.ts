export * from './FloorToken/token';
export * from './TransferTaxToken/token';

import * as FT from './FloorToken/token';
import * as TTT from './TransferTaxToken/token-external';
import {
  Args,
  bytesToU64,
  stringToBytes,
  u64ToBytes,
} from '@massalabs/as-types';
import * as ERC20 from './ERC20/token';
import {
  Address,
  Context,
  Storage,
  createEvent,
  generateEvent,
  setBytecode,
  sha256,
} from '@massalabs/massa-as-sdk';
import { _isOwner } from '@massalabs/sc-standards/assembly/contracts/utils/ownership-internal';
import { moveInitialSupply } from '../libraries/InitialSupply';

// Code upgrades only apply after this delay, so holders can see a pending upgrade (and exit)
// before it can change the token's code.
export const UPGRADE_DELAY: u64 = 7 * 24 * 60 * 60 * 1000; // 7 days, in ms
const PENDING_UPGRADE_HASH = stringToBytes('PENDING_UPGRADE_HASH');
const PENDING_UPGRADE_TIME = stringToBytes('PENDING_UPGRADE_TIME');

export function constructor(bs: StaticArray<u8>): void {
  const args = new Args(bs);

  const tokenY = args.nextString().expect('tokenY is missing or invalid');
  const factory = args.nextString().expect('factory is missing or invalid');
  const activeId = args.nextU32().expect('activeId is missing or invalid');
  const binStep = args.nextU32().expect('binStep is missing or invalid');
  const floorPerBin = args
    .nextU256()
    .expect('floorPerBin is missing or invalid');
  FT.constructor(
    new Args()
      .add(tokenY)
      .add(factory)
      .add(activeId)
      .add(binStep)
      .add(floorPerBin)
      .serialize(),
  );

  const name = args.nextString().expect('name is missing or invalid');
  const symbol = args.nextString().expect('symbol is missing or invalid');
  const decimals = args.nextU8().expect('decimals is missing or invalid');
  const supply = args.nextU256().expect('supply is missing or invalid');
  const taxRate = args.nextU256().expect('taxRate is missing or invalid');
  const taxRecipient = args
    .nextString()
    .expect('taxRecipient is missing or invalid');
  TTT.constructor(
    new Args()
      .add(name)
      .add(symbol)
      .add(decimals)
      .add(supply)
      .add(taxRecipient)
      .add(taxRate)
      .serialize(),
  );

  // Optional: who receives the initial supply. The ERC20 constructor credits the caller, which
  // is the deployer contract when the token is created through it: move the supply to the user.
  const supplyRecipient = args.nextString();
  if (supplyRecipient.isOk())
    moveInitialSupply(
      Context.caller(),
      new Address(supplyRecipient.unwrap()),
      supply,
    );
}

// ==================================================== //
// ====                 OVERRIDES                  ==== //
// ==================================================== //

export function totalSupply(_: StaticArray<u8>): StaticArray<u8> {
  return ERC20.totalSupply(_);
}

export function balanceOf(bs: StaticArray<u8>): StaticArray<u8> {
  return ERC20.balanceOf(bs);
}

/**
 * @notice safety access check is done in the internal function
 */
export function _mint(bs: StaticArray<u8>): void {
  ERC20.mint(bs);
}

/**
 * @notice safety access check is done in the internal function
 */
export function _burn(bs: StaticArray<u8>): void {
  ERC20.burnFrom(bs);
}

// Add additional business logic here
// ....

// ==================================================== //
// ====              DELAYED UPGRADES              ==== //
// ==================================================== //

function _onlyOwnerCanUpgrade(): void {
  assert(
    _isOwner(Context.caller().toString()),
    'only owner can upgrade the contract',
  );
}

function _equalBytes(a: StaticArray<u8>, b: StaticArray<u8>): bool {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}

/**
 * @notice Step 1: the owner announces new bytecode. It can be applied with `upgrade` once
 * `UPGRADE_DELAY` has passed. Proposing again replaces the pending upgrade and restarts the delay.
 * @param bs the new bytecode
 */
export function proposeUpgrade(bs: StaticArray<u8>): void {
  _onlyOwnerCanUpgrade();

  const hash = sha256(bs);
  const executableAt = Context.timestamp() + UPGRADE_DELAY;
  Storage.set(PENDING_UPGRADE_HASH, hash);
  Storage.set(PENDING_UPGRADE_TIME, u64ToBytes(executableAt));
  generateEvent(createEvent('UPGRADE_PROPOSED', [executableAt.toString()]));
}

/**
 * @notice Cancels the pending upgrade, if any.
 */
export function cancelUpgrade(_: StaticArray<u8>): void {
  _onlyOwnerCanUpgrade();

  if (Storage.has(PENDING_UPGRADE_HASH)) Storage.del(PENDING_UPGRADE_HASH);
  if (Storage.has(PENDING_UPGRADE_TIME)) Storage.del(PENDING_UPGRADE_TIME);
  generateEvent(createEvent('UPGRADE_CANCELLED', []));
}

/**
 * @notice Returns the pending upgrade: sha256 of the bytecode and the time (ms) from which it can
 * be applied, or empty bytes if there is none.
 */
export function pendingUpgrade(_: StaticArray<u8>): StaticArray<u8> {
  if (!Storage.has(PENDING_UPGRADE_HASH)) return [];
  return new Args()
    .add(Storage.get(PENDING_UPGRADE_HASH))
    .add(bytesToU64(Storage.get(PENDING_UPGRADE_TIME)))
    .serialize();
}

/**
 * @notice Step 2: applies the bytecode announced with `proposeUpgrade`, after the delay.
 * @param bs the new bytecode (must be exactly the proposed one)
 */
export function upgrade(bs: StaticArray<u8>): void {
  _onlyOwnerCanUpgrade();
  assert(Storage.has(PENDING_UPGRADE_HASH), 'no upgrade proposed');
  assert(
    _equalBytes(sha256(bs), Storage.get(PENDING_UPGRADE_HASH)),
    'bytecode differs from the proposed upgrade',
  );
  assert(
    Context.timestamp() >= bytesToU64(Storage.get(PENDING_UPGRADE_TIME)),
    'upgrade delay not elapsed',
  );

  Storage.del(PENDING_UPGRADE_HASH);
  Storage.del(PENDING_UPGRADE_TIME);
  setBytecode(bs);
}
