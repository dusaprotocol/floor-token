import {
  Address,
  Context,
  Storage,
  resetStorage,
  changeCallStack,
} from '@massalabs/massa-as-sdk';
import {
  Args,
  bytesToU64,
  stringToBytes,
  u64ToBytes,
} from '@massalabs/as-types';
import { u256 } from 'as-bignum/assembly';
import {
  _balance,
  _setBalance,
} from '@massalabs/sc-standards/assembly/contracts/FT/token-internals';
import { _setOwner } from '@massalabs/sc-standards/assembly/contracts/utils/ownership-internal';
import {
  UPGRADE_DELAY,
  cancelUpgrade,
  pendingUpgrade,
  proposeUpgrade,
  upgrade,
} from '../contracts/MyFloorToken';
import { moveInitialSupply } from '../libraries/InitialSupply';

const CODE: StaticArray<u8> = [1, 2, 3, 4];
const OTHER_CODE: StaticArray<u8> = [5, 6, 7];
const STRANGER = 'AU1zvmmP8epRx9i4Wc6DwNJGpCSEJWVpJK5VaB1i6LwtcJkwYsab';

function owner(): string {
  return Context.caller().toString();
}
function contract(): string {
  return Context.callee().toString();
}
function setPendingTimeInThePast(): void {
  Storage.set(stringToBytes('PENDING_UPGRADE_TIME'), u64ToBytes(1));
}

describe('delayed upgrade', () => {
  beforeEach(() => {
    resetStorage();
    _setOwner(owner());
  });

  test('upgrade without a proposal is rejected', () => {
    expect(() => {
      upgrade(CODE);
    }).toThrow('no upgrade proposed');
  });

  test('proposal is recorded with the delay', () => {
    const before = Context.timestamp();
    proposeUpgrade(CODE);
    const args = new Args(pendingUpgrade([]));
    args.nextBytes().unwrap();
    const executableAt = args.nextU64().unwrap();
    expect(executableAt >= before + UPGRADE_DELAY).toBe(true);
    expect(executableAt <= Context.timestamp() + UPGRADE_DELAY).toBe(true);
  });

  test('upgrade before the delay is rejected', () => {
    proposeUpgrade(CODE);
    expect(() => {
      upgrade(CODE);
    }).toThrow('upgrade delay not elapsed');
  });

  test('upgrade with other bytecode than proposed is rejected', () => {
    proposeUpgrade(CODE);
    setPendingTimeInThePast();
    expect(() => {
      upgrade(OTHER_CODE);
    }).toThrow('bytecode differs from the proposed upgrade');
  });

  test('upgrade after the delay works and clears the proposal', () => {
    proposeUpgrade(CODE);
    setPendingTimeInThePast();
    upgrade(CODE);
    expect(pendingUpgrade([]).length).toBe(0);
  });

  test('cancelled proposal can no longer be applied', () => {
    proposeUpgrade(CODE);
    setPendingTimeInThePast();
    cancelUpgrade([]);
    expect(pendingUpgrade([]).length).toBe(0);
    expect(() => {
      upgrade(CODE);
    }).toThrow('no upgrade proposed');
  });

  test('only the owner can propose', () => {
    changeCallStack(STRANGER + ' , ' + contract());
    expect(() => {
      proposeUpgrade(CODE);
    }).toThrow('only owner can upgrade the contract');
  });
});

describe('initial supply', () => {
  beforeEach(() => {
    resetStorage();
  });

  test('moves the supply from the deployer to the user', () => {
    const deployer = new Address(
      'AS12BqZEQ6sByhRLyEuf0YbQmcF2PsDdkNNG1akBJu9XcjZA1eT',
    );
    const user = new Address(STRANGER);
    const supply = u256.from(1_000_000);
    _setBalance(deployer, supply);

    moveInitialSupply(deployer, user, supply);

    expect(_balance(deployer)).toStrictEqual(u256.Zero);
    expect(_balance(user)).toStrictEqual(supply);
  });

  test('does nothing when the recipient is the caller', () => {
    const user = new Address(STRANGER);
    const supply = u256.from(42);
    _setBalance(user, supply);

    moveInitialSupply(user, user, supply);

    expect(_balance(user)).toStrictEqual(supply);
  });
});
