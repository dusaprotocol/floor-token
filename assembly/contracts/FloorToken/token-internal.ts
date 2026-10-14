import {
  BinHelper,
  IERC20,
  IPair,
  Math512Bits,
  ONE_COIN,
  PRECISION,
  SCALE_OFFSET,
  SafeMath256,
} from '@dusalabs/core';
import {
  bytesToString,
  byteToU8,
  bytesToU32,
  byteToBool,
  u32ToBytes,
  u8toByte,
  NoArg,
  bytesToU256,
  Args,
} from '@massalabs/as-types';
import {
  Address,
  Context,
  Storage,
  call,
  createEvent,
  generateEvent,
} from '@massalabs/massa-as-sdk';
import { u256 } from 'as-bignum/assembly/integer/u256';
import {
  PAIR,
  STATUS,
  BIN_STEP,
  FLOOR_ID,
  ROOF_ID,
  REBALANCE_PAUSED,
  TOKEN_Y,
  _STATUS_ENTERED,
  _STATUS_NOT_ENTERED,
  FLOOR_PER_BIN,
} from '../../storage/FloorToken';
import { TAX_RECIPIENT } from '../../storage/TransferTaxToken';
import { Tuple, masToSend } from '../../libraries/Utils';

// CLASSES

class GetAmountsInPairResult {
  constructor(
    public readonly totalFloorInPair: u256,
    public readonly totalTokenYInPair: u256,
    public readonly sharesLeftSide: u256[],
    public readonly reservesY: u256[],
  ) {}
}

// GETTERS

export function pair(): IPair {
  return new IPair(new Address(Storage.get(bytesToString(PAIR))));
}

export function status(): u8 {
  return byteToU8(Storage.get(STATUS));
}

export function binStep(): u32 {
  return bytesToU32(Storage.get(BIN_STEP));
}

export function floorId(): u32 {
  return bytesToU32(Storage.get(FLOOR_ID));
}

export function roofId(): u32 {
  return bytesToU32(Storage.get(ROOF_ID));
}

export function rebalancePaused(): bool {
  return byteToBool(Storage.get(REBALANCE_PAUSED));
}

export function activeId(): u32 {
  return pair().getPairInformation().activeId;
}

export function reserves(): Tuple<u256, u256> {
  const res = pair().getPairInformation();
  // Protocol fees should never exceed reserves, but add safety check
  const reserveX =
    res.reserveX > res.feesX.protocol
      ? SafeMath256.sub(res.reserveX, res.feesX.protocol)
      : u256.Zero;
  const reserveY =
    res.reserveY > res.feesY.protocol
      ? SafeMath256.sub(res.reserveY, res.feesY.protocol)
      : u256.Zero;
  return new Tuple(reserveX, reserveY);
}

export function protocolFees(): Tuple<u256, u256> {
  const res = pair().getPairInformation();
  return new Tuple(res.feesX.protocol, res.feesY.protocol);
}

// FUNCTIONS

/**
 * @dev Returns the amount of token and tokenY that are in the pair contract.
 * @param floorId The id of the floor bin.
 * @param activeId The id of the active bin.
 * @param roofId The id of the roof bin.
 * @return totalFloorInPair The amount of tokens that are owned by this contract as liquidity.
 * @return totalTokenYInPair The amount of tokenY that are owned by this contract as liquidity.
 * @return sharesLeftSide The amount of shares owned by this contract as liquidity from floor to active bin.
 * @return reservesY The amount of tokenY owned by this contract as liquidity.
 */
export function _getAmountsInPair(
  floorId: u32,
  activeId: u32,
  roofId: u32,
  token: Address = Context.callee(),
): GetAmountsInPairResult {
  let totalFloorInPair = u256.Zero;
  let totalTokenYInPair = u256.Zero;

  // Calculate the total number of bins and the number of bins on the left side (from floor to active bin).
  const nbBins = roofId - floorId + 1;
  const nbBinsLeftSide = floorId > activeId ? 0 : activeId - floorId + 1;

  const sharesLeftSide = new Array<u256>(nbBinsLeftSide).fill(u256.Zero);
  const reservesY = new Array<u256>(nbBinsLeftSide).fill(u256.Zero);

  const _pair = pair();

  for (let i: u32 = 0; i < nbBins; i++) {
    const id = floorId + i;

    // Get the amount of shares owned by this contract, the reserves and the total supply of each bin
    const share = _pair.balanceOf(token, id);
    const binReserves = _pair.getBin(id);
    const totalShares = _pair.totalSupply(id);

    // The check for totalShares is implicit, as `totalShares >= share`
    if (share.isZero()) continue;

    // Calculate the amounts of tokens owned by this contract and that were added as liquidity
    const reserveX =
      binReserves.reserveX > u256.Zero
        ? Math512Bits.mulDivRoundDown(share, binReserves.reserveX, totalShares)
        : u256.Zero;
    const reserveY =
      binReserves.reserveY > u256.Zero
        ? Math512Bits.mulDivRoundDown(share, binReserves.reserveY, totalShares)
        : u256.Zero;
    // generateEvent('reserveY: ' + reserveY.toString());

    // Update the total amounts
    totalFloorInPair = SafeMath256.add(totalFloorInPair, reserveX);
    totalTokenYInPair = SafeMath256.add(totalTokenYInPair, reserveY);

    // Update the arrays for the left side
    if (id <= activeId) {
      sharesLeftSide[i] = share;
      reservesY[i] = reserveY;
    }
  }

  return new GetAmountsInPairResult(
    totalFloorInPair,
    totalTokenYInPair,
    sharesLeftSide,
    reservesY,
  );
}

export function _tokensInPair(): Tuple<u256, u256> {
  const res = _getAmountsInPair(floorId(), activeId(), roofId());
  return new Tuple(res.totalFloorInPair, res.totalTokenYInPair);
}

/**
 * @dev Helper function to rebalance the floor while making sure to not steal any tokens that was sent
 * by users prior to the rebalance, for example during a swap or a liquidity addition.
 * Note: This functions **only** works if the tokenX is this contract and the tokenY is the `tokenY`.
 * @param ids The ids of the bins to burn.
 * @param shares The shares to burn.
 * @param newFloorId The new floor id.
 */
export function _safeRebalance(
  ids: u64[],
  shares: u256[],
  newFloorId: u32,
): void {
  nonReentrantBefore();

  // Get the previous reserves of the pair contract
  const resBefore = reserves();
  const reserveFloorBefore = resBefore._0;
  const reserveTokenYBefore = resBefore._1;

  // Transfer the LP shares to the pair (required before burning)
  const _pair = pair();
  _pair.safeBatchTransferFrom(
    Context.callee(),
    _pair._origin,
    ids,
    shares,
    masToSend,
  );

  // Get the tokenY balance of the floor token contract before burning
  const tokenY = new IERC20(new Address(bytesToString(Storage.get(TOKEN_Y))));
  const floorTokenYBalanceBefore = tokenY.balanceOf(Context.callee());

  // Burn the LP shares and send underlying tokens to floor token contract (not pair!)
  // This avoids the "self-transfer" error that occurs when floor tokens go pair -> pair
  _pair.burn(ids, shares, Context.callee(), masToSend);

  // Calculate how much tokenY was received from the burn
  const floorTokenYBalanceAfter = tokenY.balanceOf(Context.callee());
  const tokenYReceived = SafeMath256.sub(
    floorTokenYBalanceAfter,
    floorTokenYBalanceBefore,
  );

  // Transfer the received tokenY to the pair for the subsequent mint
  tokenY.transfer(_pair._origin, tokenYReceived);

  // Get the current tokenY balance of the pair contract (minus the protocol fees)
  const tokenYProtocolFees = protocolFees()._1;
  const tokenYBalanceSubProtocolFees = SafeMath256.sub(
    tokenY.balanceOf(_pair._origin),
    tokenYProtocolFees,
  );

  // Get the new reserves of the pair contract
  const resAfter = reserves();

  // Make sure we don't burn any bins greater or equal to the active bin, as this might send some unexpected
  // tokens to the pair contract
  assert(
    resAfter._0 == reserveFloorBefore,
    'FloorToken: token reserve changed',
  );

  // Calculate the delta amounts to get the ratio
  const deltaReserveTokenY = SafeMath256.sub(reserveTokenYBefore, resAfter._1);
  const deltaTokenYBalance = SafeMath256.sub(
    tokenYBalanceSubProtocolFees,
    resAfter._1,
  );

  // Calculate the distrib, which is 1e18 if no tokenY was in the pair contract, and the ratio between the
  // previous tokenY balance and the current one otherwise, rounded up. This is done to make sure that the
  // rebalance doesn't steal any tokenY that was sent to the pair contract by the users. This works because
  // we only add tokenY, so any token that was sent to the pair prior to the rebalance will be sent back
  // to the pair contract after the rebalance. This can't underflow as `deltaTokenYBalance > 0`.
  const prod = SafeMath256.mul(deltaReserveTokenY, PRECISION);
  const distrib =
    deltaTokenYBalance > deltaReserveTokenY
      ? SafeMath256.div(
          SafeMath256.add(prod, SafeMath256.sub(deltaTokenYBalance, u256.One)),
          deltaTokenYBalance,
        )
      : PRECISION;

  // Mint the liquidity to the pair contract, any left over will be sent back to the pair contract as
  // this would be user funds (this contains the tokenY or the tokens that were sent to the pair contract
  // prior to the rebalance)
  const r = _pair.mint(
    [newFloorId],
    [u256.Zero],
    [distrib],
    Context.callee(),
    ONE_COIN,
  );

  // Verify the invariants:
  // 1. We added at least 99.9% of what we withdrew (allowing for composition fees and rounding)
  // 2. No floor tokens were added (we're only adding tokenY)
  const minAcceptable = SafeMath256.div(
    SafeMath256.mul(deltaReserveTokenY, u256.from(999)),
    u256.from(1000),
  );

  assert(
    r.amountYAdded >= minAcceptable && r.amountXAdded == u256.Zero,
    'FloorToken: broken invariant',
  );

  nonReentrantAfter();
}

/**
 * @dev Raises the roof by `nbBins` bins. New tokens will be minted to the pair contract and directly
 * added to new bins that weren't previously in the range.
 * This will revert if the current active bin is above the current roof id.
 * @param roofId The id of the roof bin.
 * @param floorId The id of the floor bin.
 * @param nbBins The number of bins to raise the roof by.
 */
export function _raiseRoof(roofId: u32, floorId: u32, nbBins: u32): void {
  nonReentrantBefore();

  assert(nbBins > 0, 'FloorToken: zero bins');
  assert(
    roofId == 0 || activeId() <= roofId,
    'FloorToken: active bin above roof',
  );

  // Calculate the next id, if the roof wasn't already raised, the next id will be `floorId`
  const nextId = roofId == 0 ? floorId : roofId + 1;

  // Calculate the new roof id
  const newRoofId = nextId + nbBins - 1;
  assert(newRoofId <= U32.MAX_VALUE, 'FloorToken: new roof too high');

  // Calculate the amount of tokens to mint and the share per bin
  const sharePerBin = SafeMath256.div(PRECISION, u256.from(nbBins));
  const floorPerBin = bytesToU256(Storage.get(FLOOR_PER_BIN));
  const floorAmount = SafeMath256.mul(floorPerBin, u256.from(nbBins));

  // Encode the liquidity parameters for each bin
  const distributionX = new Array<u256>(nbBins).fill(sharePerBin);
  const distributionY = new Array<u256>(nbBins).fill(u256.Zero);
  const ids = new Array<u64>(nbBins).fill(0);
  for (let i: u32 = 0; i < nbBins; i++) {
    ids[i] = nextId + i;
  }

  // Get the current reserves of the pair contract
  const floorReserve = reserves()._0;
  const floorProtocolFees = protocolFees()._0;

  // Calculate the amount of tokens that are owned by the pair contract as liquidity
  const _pair = pair();
  const pairAddress = _pair._origin;
  const pairBalance = balanceOf(pairAddress);
  const floorBalanceSubProtocolFees =
    pairBalance > floorProtocolFees
      ? SafeMath256.sub(pairBalance, floorProtocolFees)
      : u256.Zero;

  // Calculate the amount of tokens that were sent to the pair contract waiting to be added as liquidity or
  // swapped for tokenY.
  // On a fresh token with no reserves, both values should be 0
  const previousBalance =
    floorBalanceSubProtocolFees > floorReserve
      ? SafeMath256.sub(floorBalanceSubProtocolFees, floorReserve)
      : u256.Zero;

  // Mint or burn the tokens to make sure that the amount of tokens that will be added as liquidity is
  // exactly `floorAmount`.
  // unsafe math is fine
  if (previousBalance > floorAmount)
    _burn(pairAddress, u256.sub(previousBalance, floorAmount));
  else if (floorAmount > previousBalance)
    _mint(pairAddress, u256.sub(floorAmount, previousBalance));

  // Mint the tokens to the pair contract and mint the liquidity
  const mintRes = _pair.mint(
    ids,
    distributionX,
    distributionY,
    Context.callee(),
    ONE_COIN,
  );

  // Make sure that no tokens Y were added as liquidity as this would mean stealing user funds.
  assert(mintRes.amountYAdded == u256.Zero, 'FloorToken: invalid amounts');

  // Make sure that the amount of tokens X that were added as liquidity is exactly `floorAmount`
  let floorInExcess = u256.Zero;
  if (mintRes.amountXAdded != floorAmount) {
    const floorReserveAfter = reserves()._0;
    const floorProtocolFeesAfter = protocolFees()._0;

    // Calculate the amount of tokens that are left from the deposit
    floorInExcess = SafeMath256.sub(
      balanceOf(pairAddress),
      SafeMath256.add(floorReserveAfter, floorProtocolFeesAfter),
    );
  }

  // Mint or burn the token to make sure that the amount of token in excess is exactly `previousBalance`
  // unsafe math is fine
  if (floorInExcess > previousBalance)
    _burn(pairAddress, u256.sub(floorInExcess, previousBalance));
  else if (previousBalance > floorInExcess)
    _mint(pairAddress, u256.sub(previousBalance, floorInExcess));

  // Update the roof id
  Storage.set(ROOF_ID, u32ToBytes(newRoofId));

  const event = createEvent('ROOF_RAISED', [newRoofId.toString()]);
  generateEvent(event);

  nonReentrantAfter();
}

export /**
 * @dev Reduces the roof by `nbBins` bins. The tokens that are removed from the roof will be burned.
 * @param roofId The id of the roof bin.
 * @param floorId The id of the floor bin.
 * @param nbBins The number of bins to reduce the roof by.
 */
function _reduceRoof(roofId: u32, floorId: u32, nbBins: u32): void {
  nonReentrantBefore();

  assert(nbBins > 0, 'FloorToken: zero bins');
  assert(roofId > nbBins, 'FloorToken: roof too low');

  const newRoofId = roofId - nbBins;

  assert(newRoofId > activeId(), 'FloorToken: new roof not above active bin');
  assert(newRoofId >= floorId, 'FloorToken: new roof below floor bin');

  const _pair = pair();

  // Calculate the ids of the bins to remove
  const ids = new Array<u64>(nbBins).fill(0);
  const shares = new Array<u256>(nbBins).fill(u256.Zero);
  for (let i: u32 = 0; i < nbBins; i++) {
    const id = roofId - i;

    ids[i] = id;
    shares[i] = _pair.balanceOf(Context.callee(), id);
  }

  // Get the actual balance of floor that was transferred to the pair contract
  const currentReserves = reserves();
  const currentFees = protocolFees();

  const floorBalance = balanceOf(_pair._origin);

  const floorExcess = SafeMath256.sub(
    floorBalance,
    SafeMath256.add(currentReserves._0, currentFees._0),
  );

  // Burn the shares and send the tokenY to the pair
  _pair.burn(ids, shares, _pair._origin, masToSend);

  // Get the current tokenY balance of the pair contract (minus the protocol fees)
  const newReserves = reserves();
  const newFees = protocolFees();

  assert(
    newReserves._1 == currentReserves._1 && newFees._1 == currentFees._1,
    'FloorToken: tokenY reserve changed',
  );

  const newFloorBalance = balanceOf(_pair._origin);

  assert(newFloorBalance == floorBalance, 'FloorToken: floor balance changed');

  const newFloorExcess = SafeMath256.sub(
    newFloorBalance,
    SafeMath256.add(newReserves._0, newFees._0),
  );

  // Burn the tokens that were removed from the pair contract
  if (newFloorExcess > floorExcess) {
    _burn(_pair._origin, SafeMath256.sub(newFloorExcess, floorExcess));
  }

  // Update the roof id
  Storage.set(ROOF_ID, u32ToBytes(newRoofId));

  const event = createEvent('ROOF_REDUCED', [newRoofId.toString()]);
  generateEvent(event);

  nonReentrantAfter();
}

/**
 * @dev Rebalances the floor by removing the bins that are not needed anymore and adding their tokenY
 * reserves to the new floor bin.
 * @return Whether the floor was rebalanced or not.
 */
export function _rebalanceFloor(): bool {
  const _floorId = floorId();
  const _activeId = activeId();
  const _roofId = roofId();

  // If the floor is already at the active bin minus one or above, no rebalance is needed.
  // We do `floorId + 1` because if the `activeId = floorId + 1`, the rebalance is not doable because
  // of the composition fee, so in order to raise the floor, the activeId has to be at least equal
  // or greater than `floorId + 2`
  if (_floorId + 1 >= _activeId) return false;

  // Get the amounts of tokens and tokenY that are in the pair contract, as well as the shares and
  // tokenY reserves owned for each bin
  const res = _getAmountsInPair(_floorId, _activeId, _roofId);

  // Calculate the amount of tokens in circulation: the total supply minus the tokens that are in
  // the pair. Every other balance (including the tax recipient's) can be sold into the floor, so it
  // must be covered by the floor reserves.
  const _totalSupply = totalSupply();
  const floorInCirculation = SafeMath256.sub(
    _totalSupply,
    res.totalFloorInPair,
  );

  // Calculate the new floor id
  const newFloorId = _calculateNewFloorId(
    _floorId,
    _activeId,
    _roofId,
    floorInCirculation,
    res.totalTokenYInPair,
    res.reservesY,
  );

  // If the new floor id is the same as the current floor id, no rebalance is needed
  if (newFloorId <= _floorId) return false;

  // Calculate the number of bins to remove
  const nbBins = newFloorId - _floorId;

  // Get the ids of the bins to remove
  const ids = new Array<u64>(nbBins).fill(0);
  let j = 0;
  for (let i: u32 = 0; i < nbBins; i++) {
    const amountY = res.reservesY[i];

    if (amountY > u256.Zero) {
      ids[j] = _floorId + i;
      res.sharesLeftSide[j] = res.sharesLeftSide[i];

      ++j;
    }
  }

  // Reduce the length of the shares array to only keep the shares of the bins that will be removed. We already
  // checked that the new floor id is greater than the current floor id, so we know that the length of the shares
  // array is greater than the number of bins to remove, so this is safe to do
  const _ids = ids.slice(0, j);
  const _shares = res.sharesLeftSide.slice(0, j);

  // Update the floor id
  Storage.set(FLOOR_ID, u32ToBytes(newFloorId));

  if (j > 0) _safeRebalance(_ids, _shares, u32(newFloorId));

  const event = createEvent('FLOOR_REBALANCED', [newFloorId.toString()]);
  generateEvent(event);

  return true;
}

export /**
 * @dev Calculates the new floor id based on the amount of floor tokens in circulation and the amount of tokenY
 * available in the pair contract.
 * @param floorId The id of the floor bin.
 * @param activeId The id of the active bin.
 * @param roofId The id of the roof bin.
 * @param floorInCirculation The amount of floor tokens in circulation.
 * @param tokenYAvailable The amount of tokenY available in the pair contract.
 * @param tokenYReserves The amount of tokenY owned by this contract as liquidity.
 * @return newFloorId The new floor id.
 */
function _calculateNewFloorId(
  floorId: u32,
  activeId: u32,
  roofId: u32,
  floorInCirculation: u256,
  tokenYAvailable: u256,
  tokenYReserves: u256[],
): u32 {
  if (floorId >= activeId) return floorId;

  // Iterate over all the ids from the active bin to the floor bin, in reverse order. The floor id can't be
  // greater than the roof id, so we use the smallest of activeId and roofId as the upper bound.
  let id = (activeId > roofId ? roofId : activeId) + 1;
  while (id > floorId) {
    --id;

    // Calculate the price of the bin and get the tokenY reserve
    const price = BinHelper.getPriceFromId(id, binStep());
    const tokenYReserve = tokenYReserves[id - floorId];

    // Calculate the amount of tokenY needed to buy all the floor token in circulation
    const tokenYNeeded = Math512Bits.mulShiftRoundUp(
      floorInCirculation,
      price,
      SCALE_OFFSET,
    );

    if (tokenYNeeded > tokenYAvailable) {
      // If the amount of tokenY needed is greater than the amount of tokenY available, we need to
      // keep iterating over the bins
      tokenYAvailable = SafeMath256.sub(tokenYAvailable, tokenYReserve);
      floorInCirculation = SafeMath256.sub(
        floorInCirculation,
        Math512Bits.shiftDivRoundDown(tokenYReserve, SCALE_OFFSET, price),
      );
    } else {
      // If the amount of tokenY needed is lower than the amount of tokenY available, we found the
      // new floor id and we can stop iterating
      break;
    }
  }

  // Make sure that the active id is strictly greater than the new floor id.
  // If it is, force it to be the active id minus 1 to make sure we never pay the composition fee as then
  // the constraint on the distribution of the tokenY reserves might be broken. `activeId - 1` is at least
  // equal or greater than `floorId` as the first check ensures that `activeId > floorId`
  return activeId > id ? u32(id) : activeId - 1;
}

// SETTERS

export function setStatus(status: u8): void {
  Storage.set(STATUS, u8toByte(status));
}

// MODIFIERS

/**
 * @notice Modifier to make sure that the function is not reentrant.
 */
export function nonReentrantBefore(): void {
  assert(status() == _STATUS_NOT_ENTERED, 'FloorToken: reentrant call');
  setStatus(_STATUS_ENTERED);
}

/**
 * @notice Modifier to make sure that the function is not reentrant.
 */
export function nonReentrantAfter(): void {
  setStatus(_STATUS_NOT_ENTERED);
}

// OVERRIDE

function balanceOf(account: Address): u256 {
  return bytesToU256(
    call(Context.callee(), 'balanceOf', new Args().add(account), 0),
  );
}

function totalSupply(): u256 {
  return bytesToU256(call(Context.callee(), 'totalSupply', NoArg, 0));
}

function _burn(account: Address, amount: u256): void {
  call(Context.callee(), '_burn', new Args().add(account).add(amount), 0);
}

function _mint(account: Address, amount: u256): void {
  call(Context.callee(), '_mint', new Args().add(account).add(amount), 0);
}
