import {
  Args,
  boolToByte,
  byteToU8,
  stringToBytes,
  u256ToBytes,
  u32ToBytes,
} from '@massalabs/as-types';
import {
  Address,
  Context,
  Storage,
  generateEvent,
} from '@massalabs/massa-as-sdk';
import {
  BIN_STEP,
  FLOOR_ID,
  FLOOR_PER_BIN,
  PAIR,
  REBALANCE_PAUSED,
  ROOF_ID,
  STATUS,
  TOKEN_Y,
  _STATUS_ENTERED,
  _STATUS_NOT_ENTERED,
} from '../../storage/FloorToken';
import {
  BinHelper,
  IERC20,
  IFactory,
  ONE_COIN,
  SafeMath256,
} from '@dusalabs/core';
import { u256 } from 'as-bignum/assembly/integer/u256';
import * as Ownable from '@massalabs/sc-standards/assembly/contracts/utils/ownership';
import {
  _calculateNewFloorId,
  _getAmountsInPair,
  _raiseRoof,
  _rebalanceFloor,
  _reduceRoof,
  _tokensInPair,
  activeId,
  binStep,
  floorId,
  pair,
  rebalancePaused,
  roofId,
  setStatus,
} from './token-internal';
import { IFloorToken } from '../../interfaces/IFloorToken';
import { IMyFloorToken } from '../../interfaces/IMyFloorToken';

export * from '@massalabs/sc-standards/assembly/contracts/utils/ownership';

/**
 * @title Floor Token
 * @author Trader Joe
 * @notice The Floor Token contract is made to be inherited by an ERC20-compatible contract.
 * It allows to create a floor for the token, which guarantees that the price of the token will never go below
 * the floor price. On every transfer, the floor will be rebalanced if needed, that is if the amount of token Y
 * available in the pair contract allows to raise the floor by at least one bin.
 * WARNING: The floor mechanism only works if the tokens that are minted are only minted and added as liquidity
 * to the pair contract. If the tokens are minted and sent to an account, the floor mechanism will not work.
 * The order of the tokens should never be changed.
 */

// CONSTRUCTOR

/**
 * @notice Constructor that initializes the contracts' parameters.
 * @dev The constructor will also deploy a new LB pair contract.
 * @param tokenY The address of the token that will be paired with the floor token.
 * @param lbFactory The address of the LB factory, only work with v2.1.
 * @param activeId The id of the active bin, this is the price floor, calculated as:
 * `(1 + binStep / 10000) ^ (activeId - 2^23)`
 * @param binStep The step between each bin, in basis points.
 * @param floorPerBin The amount of floor token that will be minted to the pair contract for each bin.
 */
export function constructor(bs: StaticArray<u8>): void {
  assert(Context.isDeployingContract(), 'already initialized');

  const args = new Args(bs);

  const tokenY = args.nextString().expect('tokenY is missing or invalid');
  const lbFactory = new IFactory(
    new Address(args.nextString().expect('lbFactory is missing or invalid')),
  );
  const activeId = args.nextU32().expect('activeId is missing or invalid');
  const binStep = args.nextU32().expect('binStep is missing or invalid');
  const floorPerBin = args
    .nextU256()
    .expect('floorPerBin is missing or invalid');

  Storage.set(BIN_STEP, u32ToBytes(binStep));
  Storage.set(FLOOR_PER_BIN, u256ToBytes(floorPerBin));
  Storage.set(TOKEN_Y, stringToBytes(tokenY));

  // Create the pair contract at `activeId - 1` to make sure no one can add `tokenY` to the floor or above
  const pair = lbFactory.createLBPair(
    Context.callee(),
    new Address(tokenY),
    activeId - 1,
    binStep,
    10 * ONE_COIN,
  );
  Storage.set(PAIR, stringToBytes(pair.toString()));

  Storage.set(FLOOR_ID, u32ToBytes(activeId));
  setStatus(_STATUS_NOT_ENTERED);

  Storage.set(ROOF_ID, u32ToBytes(0));
  Storage.set(REBALANCE_PAUSED, boolToByte(false));
}

// ENDPOINTS

/**
 * @notice Returns the price floor of the token, in 128.128 fixed point format.
 * @return The price floor of the token, in 128.128 fixed point format.
 */
export function floorPrice(_: StaticArray<u8>): StaticArray<u8> {
  return u256ToBytes(BinHelper.getPriceFromId(floorId(), binStep()));
}

/**
 * @notice Returns the amount of tokens that are paired in the pair contract as locked liquidity, ie. owned
 * by this contract.
 * @return amountFloor The amount of floor token that are paired in the pair contract as locked liquidity.
 * @return amountY The amount of tokenY that are paired in the pair contract as locked liquidity.
 */
export function tokensInPair(_: StaticArray<u8>): StaticArray<u8> {
  const res = _tokensInPair();
  return new Args().add(res._0).add(res._1).serialize();
}

/**
 * @notice Returns the new floor id if the floor was to be rebalanced.
 * @dev If the new floor id is the same as the current floor id, it means that no rebalance is needed.
 * @return The new floor id if the floor was to be rebalanced.
 */
export function calculateNewFloorId(_: StaticArray<u8>): StaticArray<u8> {
  const res = _getAmountsInPair(floorId(), activeId(), roofId());

  const token = new IMyFloorToken(Context.callee());
  const _totalSupply = token.totalSupply();
  // every token outside the pair (including the tax recipient's) can be sold into the floor
  const floorInCirculation = SafeMath256.sub(
    _totalSupply,
    res.totalFloorInPair,
  );

  return u32ToBytes(
    _calculateNewFloorId(
      floorId(),
      activeId(),
      roofId(),
      floorInCirculation,
      res.totalTokenYInPair,
      res.reservesY,
    ),
  );
}

/**
 * @notice Force the floor to be rebalanced, in case it wasn't done automatically.
 * @dev This function can be called by anyone, but only if the rebalance is not paused and if the floor
 * needs to be rebalanced.
 * The nonReentrant check is done in `_safeRebalance`.
 */
export function rebalanceFloor(_: StaticArray<u8>): void {
  assert(!rebalancePaused(), 'FloorToken: rebalance paused');
  assert(_rebalanceFloor(), 'FloorToken: no rebalance needed');
}

/**
 * @notice Raises the roof by `nbBins` bins. New tokens will be minted to the pair contract and directly
 * added to new bins that weren't previously in the range. This will not decrease the floor price as the
 * tokens minted are directly added to the pair contract, so the circulating supply is not increased.
 * @dev The new roof will be `roofId + nbBins`, or `floorId + nbBins - 1` if the roof wasn't
 * already raised. Only callable by the owner.
 * This functions should not be called too often as it will increase the gas cost of the transfers, and
 * might even make the transfers fail if the transaction runs out of gas. It is recommended to only call this
 * function when the active bin is close to the roof bin.
 * The nonReentrant check is done in `_raiseRoof`.
 * @param nbBins The number of bins to raise the floor by.
 */
export function raiseRoof(bs: StaticArray<u8>): void {
  Ownable.onlyOwner();

  const nbBins = new Args(bs).nextU32().expect('nbBins is missing or invalid');
  _raiseRoof(roofId(), floorId(), nbBins);
}

/**
 * @notice Reduces the roof by `nbBins` bins. The tokens that are removed from the roof will be burned.
 * This will not decrease the floor price as the tokens are burned, so the circulating supply doesn't
 * change. Only callable by the owner.
 * @dev The new roof will be `roofId - nbBins`, up to the active bin, unless the floor is above it.
 * This function should be called when the roof is too high compared to the active bin, as it will
 * reduce the gas cost of the transfers.
 * @param nbBins The number of bins to reduce the roof by.
 */
export function reduceRoof(bs: StaticArray<u8>): void {
  Ownable.onlyOwner();

  const nbBins = new Args(bs).nextU32().expect('nbBins is missing or invalid');
  _reduceRoof(roofId(), floorId(), nbBins);
}

/**
 * @notice Pauses the rebalance of the floor.
 * @dev Only callable by the owner.
 */
export function pauseRebalance(_: StaticArray<u8>): void {
  Ownable.onlyOwner();
  assert(!rebalancePaused(), 'FloorToken: rebalance already paused');

  Storage.set(REBALANCE_PAUSED, boolToByte(true));

  generateEvent('REBALANCE_PAUSED');
}

/**
 * @notice Unpauses the rebalance of the floor.
 * @dev Only callable by the owner when the active bin is below the roof bin.
 */
export function unpauseRebalance(_: StaticArray<u8>): void {
  Ownable.onlyOwner();
  assert(rebalancePaused(), 'FloorToken: rebalance already unpaused');

  assert(
    roofId() == 0 || activeId() <= roofId(),
    'FloorToken: active bin above roof',
  );

  Storage.set(REBALANCE_PAUSED, boolToByte(false));

  generateEvent('REBALANCE_UNPAUSED');
}

/**
 * @dev Overrides the `_beforeTokenTransfer` function to rebalance the floor if needed and when possible.
 * @param from The address of the sender.
 * @param to The address of the recipient.
 * @param amount The amount of tokens to transfer.
 */
export function _beforeTokenTransfer(bs: StaticArray<u8>): void {
  assert(
    Context.caller().equals(Context.callee()),
    'only this contract can call this function',
  );

  const args = new Args(bs);
  const from = new Address(
    args.nextString().expect('from is missing or invalid'),
  );
  const to = new Address(args.nextString().expect('to is missing or invalid'));

  if (from == new Address('0') || to == new Address('0')) return;

  if (rebalancePaused()) return;

  // If the token is being transferred from the pair contract, it can't be rebalanced as the
  // reentrancy guard will prevent it. Also prevent the active bin to be above the roof bin.
  if (from == pair()._origin) {
    assert(activeId() <= roofId(), 'FloorToken: active bin above roof');

    return;
  }

  // If the rebalance is not paused, rebalance the floor if needed
  const status = byteToU8(Storage.get(STATUS));
  if (status == _STATUS_NOT_ENTERED) _rebalanceFloor();
}

// ABSTRACT

/**
 * @notice Returns the amount of floor tokens owned by `account`.
 * @dev This function needs to be overriden by the child contract.
 * @param account The account to get the balance of.
 * @return The amount of tokens owned by `account`.
 */
export function balanceOf(account: Address): u256 {
  throw new Error('must be implemented by child');
}

/**
 * @notice Returns the total supply of the token.
 * @dev This function needs to be overriden by the child contract.
 * @return The total supply of the token.
 */
export function totalSupply(): u256 {
  throw new Error('must be implemented by child');
}

/**
 * @dev Mint tokens to an account.
 * This function needs to be overriden by the child contract and should not trigger any callback for safety.
 * @param account The address of the account to mint tokens to.
 * @param amount The amount of tokens to mint.
 */
export function _mint(bs: StaticArray<u8>): void {
  throw new Error('must be implemented by child');
}

/**
 * @dev Burn tokens from an account.
 * This function needs to be overriden by the child contract and should not trigger any callback for safety.
 * @param account The address of the account to burn tokens from.
 * @param amount The amount of tokens to burn.
 */
export function _burn(bs: StaticArray<u8>): void {
  throw new Error('must be implemented by child');
}

// MISC

/**
 * @notice Function used by an SC to receive Massa coins
 * @param _ unused
 */
export function receiveCoins(_: StaticArray<u8>): void {}
