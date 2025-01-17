import BN from 'bn.js';

import Web3 from "web3";

import { Context } from './context';
import { ValidatorSetHbbft } from '../contracts/ValidatorSetHbbft';
import { StakingHbbftCoins } from '../contracts/StakingHbbftCoins';
import { BlockRewardHbbftCoins } from '../contracts/BlockRewardHbbftCoins';
import { KeyGenHistory } from '../contracts/KeyGenHistory';
import { observable } from 'mobx';
import { Pool } from "./model";
import { ContractManager } from "./contracts/contractManager";
import { BlockType, NonPayableTx } from '../contracts/types';

// needed for querying injected web3 (e.g. from Metamask)
declare global {
  interface Window {
    ethereum: Web3;
    web3: Web3;
  }
}


/**Fetches data for the model. */
export class ModelDataAdapter {


  @observable public context: Context = new Context();

  public web3!: Web3;

  public url!: URL;

  public hasWeb3BrowserSupport = false;

  public defaultTxOpts = {
    from: '', gasPrice: '100000000000', gasLimit: '6000000', value: '0',
  };



  private vsContract!: ValidatorSetHbbft;

  private stContract!: StakingHbbftCoins;

  private brContract!: BlockRewardHbbftCoins;

  private kghContract!: KeyGenHistory;

  private contracts! : ContractManager;

  private _isShowHistoric: boolean = false;

  @observable public isReadingData: boolean = false;

  @observable public lastError?: unknown = undefined;
  
  private showHistoricBlock: number = 0;

  @observable public isSyncingPools = true;

  private _uiElementsToUpdate = new Array<React.Component>();

  public get isShowHistoric() : boolean {
    return this._isShowHistoric; 
  }

  public registerUIElement(element: React.Component) {
    this._uiElementsToUpdate.push(element);
  }

  public unregisterUIElement(element: React.Component) {

    const index = this._uiElementsToUpdate.indexOf(element);

    function spliceNoMutate<T>(myArray: Array<T>, indexToRemove: number) : Array<T> {
      return myArray.slice(0,indexToRemove).concat(myArray.slice(indexToRemove+1));
    }

    if (index ) {
      this._uiElementsToUpdate = spliceNoMutate(this._uiElementsToUpdate, index);
      console.log(`element unregistered at index ${index}`);
    }
  }
  

  // TODO: properly implement singleton pattern
  // eslint-disable-next-line max-len
  public static async initialize(url: URL): Promise<ModelDataAdapter> {
    
    console.log('initializing new context. ', url.toString());
    
    const result = new ModelDataAdapter();
    result.url = url;
    result.web3 = new Web3(url.toString());
    result.contracts = new ContractManager(result.web3);
    
    
    result.vsContract = result.contracts.getValidatorSetHbbft();
    result.stContract = await result.contracts.getStakingHbbft();
    result.brContract = await result.contracts.getRewardHbbft();
    result.kghContract = await result.contracts.getKeyGenHistory();
    
    result.defaultTxOpts.from = result.context.myAddr;

    console.log('default: ', result.defaultTxOpts);

    await result.initContracts();

    console.log('default block after init: ', result.web3.eth.defaultBlock);
    // treat the first think as "new epoch" - so all available data get's queried.
    await result.syncPoolsState(true);
    result.isSyncingPools = false;

    await result.updateEventSubscription();

    //await result.retrieveOneShotInfos();

    return result;
  }


  public async showHistoric(blockNumber: number) {

    if (!this.isShowHistoric || this.showHistoricBlock !== blockNumber) {
      this._isShowHistoric = true;
      this.showHistoricBlock = blockNumber;
      this.web3.eth.defaultBlock = blockNumber;
      //async call.
      this.refresh();
    }
  }

  public async showLatest() {

    if (this.isShowHistoric) {

      console.error('show latest.');
      this._isShowHistoric = false;
      this.web3.eth.defaultBlock = 'latest';
      //async call.
      this.refresh();
    }
  }

  private getBlockHistoryInfoAsString() {
    return this._isShowHistoric ? `historic block #${this.showHistoricBlock}` : 'latest';
  }

  private async refresh() {

    try {

    
      const history_info = this.getBlockHistoryInfoAsString();
      console.log('starting data refresh', history_info);
      this.isReadingData = true;
      this._uiElementsToUpdate.forEach(x => x.forceUpdate());
      await this.retrieveGlobalValues();
      await this.retrieveValuesFromContract();
      await this.syncPoolsState(true);
      this.isReadingData = false;
      this.lastError = undefined;
      console.log('finished data refresh - updating UI.', history_info);
    } catch(e: unknown) {
      this.lastError = e;
      this.isReadingData = false;
    }

    
    this._uiElementsToUpdate.forEach(x => x.forceUpdate());
  }

  private async initContracts(): Promise<void> {
    this.refresh();
  }

  /**
   * get values that are independend 
   */
  private async retrieveGlobalValues() {

    if (this.web3.eth.defaultBlock === undefined || this.web3.eth.defaultBlock === 'latest') {
      console.warn('getting from eth', this.web3.eth.defaultBlock);
      this.context.currentBlockNumber = await this.web3.eth.getBlockNumber();
      this.context.latestBlockNumber  = this.context.currentBlockNumber;
    } else if ( typeof this.web3.eth.defaultBlock === 'number' ) {
      console.warn('getting from number', this.web3.eth.defaultBlock);
        this.context.currentBlockNumber = this.web3.eth.defaultBlock;
        this.context.latestBlockNumber  = await this.web3.eth.getBlockNumber();
        this.web3.defaultBlock = this.web3.eth.defaultBlock;
    } else {
      console.warn('unexpected defaultBlock: ', this.web3.eth.defaultBlock);
    }

    this.context.candidateMinStake = new BN(await this.stContract.methods.candidateMinStake().call(this.tx(), this.block()));
    this.context.delegatorMinStake = new BN(await this.stContract.methods.delegatorMinStake().call(this.tx(), this.block()));

    // those values are asumed to be not changeable.
    this.context.epochDuration = parseInt(await (await this.contracts.getStakingHbbft()).methods.stakingFixedEpochDuration().call(this.tx(), this.block()));
    this.context.stakeWithdrawDisallowPeriod = parseInt(await (await this.contracts.getStakingHbbft()).methods.stakingWithdrawDisallowPeriod().call(this.tx(), this.block()));
  }

  private tx() : NonPayableTx | undefined {
    return undefined;
  }

  private block() :  BlockType {

    if ( this._isShowHistoric ) {
      return this.showHistoricBlock;
    }

    return 'latest';
  }

  private async retrieveValuesFromContract(): Promise<void> {
    const oldStakingEpoch = this.context.stakingEpoch;
    this.context.stakingEpoch = parseInt(await this.stContract.methods.stakingEpoch().call(this.tx(), this.block()));

    if (this.context.stakingEpoch !== oldStakingEpoch) {
      this.context.epochStartBlock = parseInt(await this.stContract.methods.stakingEpochStartBlock().call(this.tx(), this.block()));
      this.context.epochStartTime = parseInt(await this.stContract.methods.stakingEpochStartTime().call(this.tx(), this.block()));

      const deltaPotValue = await this.brContract.methods.deltaPot().call(this.tx(), this.block());
      console.log('got delta pot value: ', deltaPotValue);
      this.context.deltaPot = this.web3.utils.fromWei(deltaPotValue, 'ether');

      const reinsertPotValue = await this.brContract.methods.reinsertPot().call(this.tx(), this.block());
      console.log('got reinsert pot value: ', reinsertPotValue);
      this.context.reinsertPot = this.web3.utils.fromWei(reinsertPotValue, 'ether');

      // could be calculated instead of called from smart contract?!
      this.context.stakingEpochEndTime = parseInt(await this.stContract.methods.stakingFixedEpochEndTime().call(this.tx(), this.block()));
    }

    if (this.hasWeb3BrowserSupport) {
      this.context.myBalance = new BN(await this.web3.eth.getBalance(this.context.myAddr));
    }

    this.context.canStakeOrWithdrawNow = await this.stContract.methods.areStakeAndWithdrawAllowed().call(this.tx(), this.block());
  }

  private createEmptyPool(stakingAddress: string): Pool {
    const result = new Pool(this.context);
    
    result.stakingAddress = stakingAddress;
    return result;
  }


  private async syncPoolsState(isNewEpoch: boolean): Promise<void> {
    const blockNumberAtBegin = this.context.currentBlockNumber;
    const newCurrentValidatorsUnsorted = (await this.vsContract.methods.getValidators().call(this.tx(), this.block()));
    const newCurrentValidators = [...newCurrentValidatorsUnsorted].sort();
    // apply filter here ?!

    const validatorWithoutPool: Array<string> = [...newCurrentValidators];

    if (blockNumberAtBegin !== this.context.currentBlockNumber) { console.warn('detected slow pool sync'); return; }
    const activePoolAddrs: Array<string> = await this.stContract.methods.getPools().call(this.tx(), this.block());
    // console.log('active Pools:', activePoolAddrs);
    if (blockNumberAtBegin !== this.context.currentBlockNumber) { console.warn('detected slow pool sync'); return; }
    const inactivePoolAddrs: Array<string> = await this.stContract.methods.getPoolsInactive().call(this.tx(), this.block());
    // console.log('inactive Pools:', inactivePoolAddrs);
    if (blockNumberAtBegin !== this.context.currentBlockNumber) { console.warn('detected slow pool sync'); return; }
    const toBeElectedPoolAddrs = await this.stContract.methods.getPoolsToBeElected().call(this.tx(), this.block());
    // console.log('to be elected Pools:', toBeElectedPoolAddrs);
    if (blockNumberAtBegin !== this.context.currentBlockNumber) { console.warn('detected slow pool sync'); return; }
    const pendingValidatorAddrs = await this.vsContract.methods.getPendingValidators().call(this.tx(), this.block());
    // console.log('pendingMiningPools:', pendingValidatorAddrs);
    if (blockNumberAtBegin !== this.context.currentBlockNumber) { console.warn('detected slow pool sync'); return; }
    console.log(`syncing ${activePoolAddrs.length} active and ${inactivePoolAddrs.length} inactive pools...`);
    const poolAddrs = activePoolAddrs.concat(inactivePoolAddrs);
    if (blockNumberAtBegin !== this.context.currentBlockNumber) { console.warn('detected slow pool sync'); return; }
    // make sure both arrays were sorted beforehand
    if (this.context.currentValidators.toString() !== newCurrentValidators.toString()) {
      console.log(`validator set changed in block ${this.context.currentBlockNumber} to: ${newCurrentValidators}`);
      this.context.currentValidators = newCurrentValidators;
    }
    if (blockNumberAtBegin !== this.context.currentBlockNumber) { console.warn('detected slow pool sync'); return; }

    // check if there is a new pool that is not tracked yet within the context.
    poolAddrs.forEach((poolAddress) => {
      const findResult = this.context.pools.find((x) => x.stakingAddress === poolAddress);
      if (!findResult) {
        this.context.pools.push(this.createEmptyPool(poolAddress));
      }
    });

    const poolsToUpdate = this.context.pools.map(async (p) => {
      if (blockNumberAtBegin !== this.context.currentBlockNumber) { console.warn('detected slow pool sync in pools'); return; }

      await this.updatePool(p, activePoolAddrs, toBeElectedPoolAddrs,
        pendingValidatorAddrs, isNewEpoch);
      const ixValidatorWithoutPool = validatorWithoutPool.indexOf(p.miningAddress);
      if (ixValidatorWithoutPool !== -1) {
        validatorWithoutPool.splice(ixValidatorWithoutPool, 1);
      }
    });

    await Promise.all(poolsToUpdate);

    this.context.numbersOfValidators = this.context.pools.filter(x=>x.isCurrentValidator).length;

    this.context.currentValidatorsWithoutPools = validatorWithoutPool;
    this.context.pools = this.context.pools.sort((a, b) => a.stakingAddress.localeCompare(b.stakingAddress));

    
  }

  private async getClaimableReward(stakingAddr: string): Promise<string> {
    if (!this.hasWeb3BrowserSupport) {
      return '0';
    }
    // getRewardAmount() fails if invoked for a staker without stake in the pool, thus we check that beforehand
    const hasStake: boolean = stakingAddr === this.context.myAddr ? true : (await this.stContract.methods.stakeFirstEpoch(stakingAddr, this.context.myAddr).call(this.tx(), this.block())) !== '0';
    return hasStake ? this.stContract.methods.getRewardAmount([], stakingAddr, this.context.myAddr).call(this.tx(), this.block()) : '0';
  }

  private async getMyStake(stakingAddress: string): Promise<string> {
    if (!this.hasWeb3BrowserSupport) {
      return '0';
    }
    return this.stContract.methods.stakeAmount(stakingAddress, this.context.myAddr).call(this.tx(), this.block());
  }

  private async getBannedUntil(miningAddress: string): Promise<BN> {
    return new BN((await this.vsContract.methods.bannedUntil(miningAddress).call(this.tx(), this.block())));
  }

  private async getBanCount(miningAddress: string): Promise<number> {
    return parseInt(await this.vsContract.methods.banCounter(miningAddress).call(this.tx(), this.block()));
  }

  private async getAvailableSince(miningAddress: string): Promise<BN> {
    const rawResult = await this.vsContract.methods.validatorAvailableSince(miningAddress).call(this.tx(), this.block());
    // console.log('available sinc:', new BN(rawResult).toString('hex'));
    return new BN(rawResult);
  }

  private async updatePool(
    pool: Pool,
    activePoolAddrs: Array<string>,
    toBeElectedPoolAddrs: Array<string>,
    pendingValidatorAddrs: Array<string>,
    isNewEpoch: boolean) : Promise<void> {

    const { stakingAddress } = pool;
    // console.log(`checking pool ${stakingAddress}`);
    //const ensNamePromise = this.getEnsNameOf(pool.stakingAddress);
    // console.log(`ens: ${stakingAddress}`);
    // TODO: figure out if this value can be cached or not.
    pool.miningAddress = await this.vsContract.methods.miningByStakingAddress(stakingAddress).call(this.tx(), this.block());
    pool.miningPublicKey = await this.vsContract.methods.getPublicKey(pool.miningAddress).call(this.tx(), this.block());
    // console.log(`minigAddress: ${pool.miningAddress}`);

    const { miningAddress } = pool;

    pool.isActive = activePoolAddrs.indexOf(stakingAddress) >= 0;
    pool.isToBeElected = toBeElectedPoolAddrs.indexOf(stakingAddress) >= 0;

    pool.isPendingValidator = pendingValidatorAddrs.indexOf(miningAddress) >= 0;
    pool.isCurrentValidator = this.context.currentValidators.indexOf(miningAddress) >= 0;

    pool.candidateStake = new BN(await this.stContract.methods.stakeAmount(stakingAddress, stakingAddress).call(this.tx(), this.block()));
    pool.totalStake = new BN(await this.stContract.methods.stakeAmountTotal(stakingAddress).call(this.tx(), this.block()));
    pool.myStake = new BN(await this.getMyStake(stakingAddress));

    if (this.hasWeb3BrowserSupport) {
      // there is a time, after a validator was chosen,
      // the state is still locked.
      // so the stake can just get "unlocked" in a block between epoch phases.

      // const claimableStake = {
      //   amount: await this.stContract.methods.orderedWithdrawAmount(stakingAddress, this.context.myAddr).call(this.tx(), this.block()),
      //   unlockEpoch: parseInt(await this.stContract.methods.orderWithdrawEpoch(stakingAddress, this.context.myAddr).call(this.tx(), this.block())) + 1,
      //   // this lightweigt solution works, but will not trigger an update by itself when its value changes
      //   canClaimNow: () => claimableStake.amount.asNumber() > 0 && claimableStake.unlockEpoch <= this.context.stakingEpoch,
      // };
      //pool.claimableStake = claimableStake;
      if (isNewEpoch) {
        pool.claimableReward = await this.getClaimableReward(pool.stakingAddress);
      }
    }

    // TODO: delegatorAddrs ?!
    // pool.delegatorAddrs = Array<string> = await this.stContract.methods.poolDelegators(stakingAddress).call(this.tx(), this.block());

    pool.bannedUntil = new BN(await this.getBannedUntil(miningAddress));
    pool.banCount = await this.getBanCount(miningAddress);

    // console.log('before get available since: ', pool.availableSince);
    pool.availableSince = await this.getAvailableSince(miningAddress);
    pool.isAvailable = !pool.availableSince.isZero();

    // console.log('after get available since: ', pool.availableSince);

    // const stEvents = await this.stContract.getPastEvents('allEvents', { fromBlock: 0 });
    // there are between 1 and n AddedPool events per pool. We're looking for the first one
    // const poolAddedEvent = stEvents.filter((e) => e.event === 'AddedPool'
    //  && e.returnValues.poolStakingAddress === stakingAddress)

    //   .sort((e1, e2) => e1.blockNumber - e2.blockNumber);

    //  console.assert(poolAddedEvent.length > 0, `no AddedPool event found for ${stakingAddress}`);

    // if (poolAddedEvent.length === 0) {
    //   console.error(stEvents);
    // }

    // result can be negative for pools added as "initial validators", thus setting 0 as min value
    // const addedInEpoch = Math.max(0, Math.floor((poolAddedEvent[0].blockNumber
    //  - this.posdaoStartBlock) / this.epochDuration));

    // TODO FIX: what's the use for addedInEpoch ?!
    // const addedInEpoch = 0;

    // fetch and add the number of blocks authored per epoch since this pool was created
    // const blocksAuthored = await [...Array(this.stakingEpoch - addedInEpoch)]
    //   .map(async (_, i) => parseInt(await this.brContract.methods.blocksCreated(this.stakingEpoch
    // - i, miningAddress).call(this.tx(), this.block())))
    //   .reduce(async (acc, cur) => await acc + await cur);

    // const blocksAuthored = 0;

    if (pool.isPendingValidator) {
      pool.parts = await this.kghContract.methods.parts(miningAddress).call(this.tx(), this.block());
      const acksLengthBN = new BN(await this.kghContract.methods.getAcksLength(miningAddress).call(this.tx(), this.block()));
      pool.numberOfAcks = acksLengthBN.toNumber();
    } else { // could just have lost the pendingValidatorState - so we clear this field ?!
      pool.parts = '';
      pool.numberOfAcks = 0;
    }

    // done in the background, non-blocking
    // ensNamePromise.then((name) => {
    //   pool.ensName = name;
    // });

    // console.log('pool got updated: ', pool);
  }


  private newBlockPolling?: NodeJS.Timeout = undefined;

  /**
   * updates the event subscript based on the fact 
   * if we are browsing historic data or not.
   */
  private updateEventSubscription() {

    console.log('updating event subscription. is historic:', this.isShowHistoric);

    if (this.isShowHistoric) {
      // if we browse historic, we can safely unsusbscribe from events.
      this.unsubscribeToEvents();
    }
    else {
      // if we are tracking the latest block,
      // we only subscript to event if we have not done already.

      if (!this.newBlockPolling) {
        this.subscribeToEvents();
      }
    }
  }

  private  unsubscribeToEvents() {
    if (this.newBlockPolling) {
      clearInterval(this.newBlockPolling);
      this.newBlockPolling = undefined;
    }
  }

  private async subscribeToEvents(): Promise<void> {

    // since web3 websockets never made it to be a full supported standard,
    // like MetaMask do not support them,
    // there seems not to be a better way currently other then 
    // polling like stupid.

    // todo: If we query historic informations, we do not need this subscription.
  

    //this.context.currentBlockNumber = await web3Instance.eth.getBlockNumber();
    //this.context.latestBlockNumber = this.context.currentBlockNumber;

    this.unsubscribeToEvents();
    

    this.newBlockPolling = setInterval(async () =>  {
      // we make a double check, if we are really
      // should not browse historic.
      if (this.isShowHistoric) {
        return;
      }

      const currentBlock = await this.web3.eth.getBlockNumber();
      if (currentBlock > this.context.currentBlockNumber) {
        await this.handleNewBlock();
      }
      // todo: what if the RPCC internet connection is slower than the interval ?
    }, 1000);
  }


  // does relevant state updates and checks if the epoch changed
  private async handleNewBlock() : Promise<void> {

    console.error('handling new block.');
    const blockHeader = await this.web3.eth.getBlock('latest');
    this.context.currentBlockNumber = blockHeader.number;
    console.log(`current Block Number: `, this.context.currentBlockNumber);
    this.context.currentTimestamp = new BN(blockHeader.timestamp);

    if (this.hasWeb3BrowserSupport) {
      this.context.myBalance = new BN(await this.web3.eth.getBalance(this.context.myAddr));
    }

    // epoch change
    console.log(`updating stakingEpochEndBlock at block ${this.context.currentBlockNumber}`);
    const oldEpoch = this.context.stakingEpoch;
    await this.retrieveValuesFromContract();

    const isNewEpoch = oldEpoch !== this.context.stakingEpoch;

    // TODO FIX: blocks left in Epoch can't get told.
    // const blocksLeftInEpoch = this.stakingEpochEndBlock - this.currentBlockNumber;
    // if (blocksLeftInEpoch < 0) {
    //   // TODO: we should have a contract instance connected via websocket in order to avoid this delay
    //   console.log('stakingEpochEndBlock in the past :-/');
    // } else if (blocksLeftInEpoch > this.stakeWithdrawDisallowPeriod) {
    //   this.stakingAllowedTimeframe = blocksLeftInEpoch - this.stakeWithdrawDisallowPeriod;
    // } else {
    //   this.stakingAllowedTimeframe = -blocksLeftInEpoch;
    // }

    // TODO: due to the use of 2 different web3 instances, this bool may not always match stakingAllowedTimeframe
    this.context.canStakeOrWithdrawNow = await this.stContract.methods.areStakeAndWithdrawAllowed().call(this.tx(), this.block());

    // TODO: don't do this in every block. There's no event we can rely on, but we can be smarter than this
    // await this.updateCurrentValidators();

    await this.syncPoolsState(isNewEpoch);
  }






}