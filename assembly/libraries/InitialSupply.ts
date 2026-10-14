import { Address } from '@massalabs/massa-as-sdk';
import {
  _balance,
  _setBalance,
} from '@massalabs/sc-standards/assembly/contracts/FT/token-internals';
import { u256 } from 'as-bignum/assembly';
import { SafeMath256 } from '@dusalabs/core';

/**
 * Moves the initial supply credited by the ERC20 constructor (to its caller, e.g. the deployer
 * contract) to the account that should own it. A plain balance move: no transfer tax applies.
 */
export function moveInitialSupply(
  from: Address,
  to: Address,
  supply: u256,
): void {
  if (to.toString() == from.toString() || supply == u256.Zero) return;
  _setBalance(from, SafeMath256.sub(_balance(from), supply));
  _setBalance(to, SafeMath256.add(_balance(to), supply));
}
