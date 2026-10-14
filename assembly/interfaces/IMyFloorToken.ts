import { Address, call } from '@massalabs/massa-as-sdk';
import { IFloorToken } from './IFloorToken';
import { ITransferTaxToken } from './ITransferTaxToken';
import { ITransferDoubleTaxToken } from './ITransferDoubleTaxToken';
import { IERC20, IFactory } from '@dusalabs/core';
import { u256 } from 'as-bignum/assembly/integer/u256';
import { Args, NoArg, bytesToU256 } from '@massalabs/as-types';

export class IMyFloorToken {
  floor: IFloorToken;
  transferTax: ITransferTaxToken; // or ITransferDoubleTaxToken

  constructor(public _origin: Address) {
    this.floor = new IFloorToken(_origin);
    this.transferTax = new ITransferTaxToken(_origin);
  }

  init(
    tokenY: IERC20,
    lbFactory: IFactory,
    activeId: u32,
    binStep: u32,
    floorPerBin: u256,
    name: string,
    symbol: string,
    decimals: u8,
    supply: u256,
    taxRate: u256,
    taxRecipient: Address,
    supplyRecipient: Address,
  ): void {
    call(
      this._origin,
      'constructor',
      new Args()
        .add(tokenY)
        .add(lbFactory._origin)
        .add(activeId)
        .add(binStep)
        .add(floorPerBin)
        .add(name)
        .add(symbol)
        .add(decimals)
        .add(supply)
        .add(taxRate)
        .add(taxRecipient)
        .add(supplyRecipient),
      0,
    );
  }

  balanceOf(account: Address): u256 {
    const res = call(this._origin, 'balanceOf', new Args().add(account), 0);
    return bytesToU256(res);
  }

  totalSupply(): u256 {
    const res = call(this._origin, 'totalSupply', NoArg, 0);
    return bytesToU256(res);
  }
}
