import { expect } from "chai";
import { ethers } from "hardhat";
import MerkleTree from "merkletreejs";
import { MerkleNFT } from "../typechain-types";

const {utils, getSigners} = ethers

describe("MerkleNFT", function () {

  enum Stages {
    PRESALE,
    PUBLIC_SALE,
    SUPPLY_RUN_OUT
  }

  const NAME = 'MerkleNFT'
  const SYMBOL = 'NFT'
  const PUBLIC_SALE_PRICE = utils.parseEther('0.1')
  const PRESALE_PRICE = utils.parseEther('0.001')
  const MAX_SUPPLY = 30

  let contract: MerkleNFT
  let accounts: Awaited<ReturnType<typeof getSigners>>
  let leaves: string[]
  let addresses: string[]
  let merkleTree: MerkleTree
  let root: Buffer

  const generateProof = (accountIndex: number) =>{
    return merkleTree.getHexProof(leaves[accountIndex])
  }

  beforeEach(async () => {
    accounts = await ethers.getSigners()
    addresses = accounts.map(account=>account.address)
  })

  describe('Minting with mapping', async () => {

    const mintAllFromPresale = async ()=>{
      for(let i = 0; i < accounts.length; i++){
        const proof = generateProof(i);
        
        const tx = await contract.connect(accounts[i]).mintWithMapping(proof, leaves[i], {value: PRESALE_PRICE})
        await tx.wait()
      }
    }

    beforeEach(async()=>{
      leaves = addresses.map(address => utils.keccak256(address))
      merkleTree = new MerkleTree(leaves, utils.keccak256, {sortPairs: true})
      root = merkleTree.getRoot()
      const hexRoot = utils.hexValue(root) 
  
      const ContractFactory = await ethers.getContractFactory('MerkleNFT')
      contract = await ContractFactory.deploy(NAME, SYMBOL, hexRoot)
      await contract.deployed()
    })
    
    it('mints properly during presale', async () => {
      const EXPECTED_PREMINT_BALANCE = 0
      const EXPECTED_POSTMINT_BALANCE = 1
      
      for(let i = 0; i < accounts.length; i++){
        expect(await contract.balanceOf(addresses[i])).to.be.equal(EXPECTED_PREMINT_BALANCE)
      }

      await mintAllFromPresale()

      for(let i = 0; i < accounts.length; i++){
        expect(await contract.balanceOf(addresses[i])).to.be.equal(EXPECTED_POSTMINT_BALANCE)
      }

    })

    it('reverts when minting with too low or too high msg.value during presale', async () => {
      
      const proof = generateProof(0)

      await expect(contract.connect(accounts[0]).mintWithMapping(proof, leaves[0], {value: utils.parseEther('0.0001')})).to.be.revertedWith("MerkleNFT: invalid amount of ether sent")
      await expect(contract.connect(accounts[0]).mintWithMapping(proof, leaves[0], {value: utils.parseEther('0.01')})).to.be.revertedWith("MerkleNFT: invalid amount of ether sent")
    })

    it('changes stage from PRESALE to PUBLIC_SALE after all nfts from presale are minted', async () => {
      expect(await contract.stage()).to.be.equal(Stages.PRESALE)
      
      await mintAllFromPresale()

      expect(await contract.stage()).to.be.equal(Stages.PUBLIC_SALE)
    })

    it('reverts if user tries to mint twice during presale', async () => {
      
      const proof = generateProof(0);

      const tx = await contract.connect(accounts[0]).mintWithMapping(proof, leaves[0], {value: PRESALE_PRICE})
      await tx.wait()

      await expect(contract.connect(accounts[0]).mintWithMapping(proof, leaves[0], {value: PRESALE_PRICE})).to.be.revertedWith("MerkleNFT: user has already minted")
    })

    it('reverts if user tries to mint (regular mint) during presale', async () => {
      await expect(contract.connect(accounts[0]).mint({value: PUBLIC_SALE_PRICE})).to.be.revertedWith("MerkleNFT: invalid stage")
    })

    it('mints properly after presale', async () => {
      expect(await contract.stage()).to.be.equal(Stages.PRESALE)
      
      await mintAllFromPresale()
      
      const tx = await contract.connect(accounts[0]).mint({value: PUBLIC_SALE_PRICE})
      await tx.wait()
      
      expect(await contract.balanceOf(addresses[0])).to.be.equal(2)
    })
    
    it('reverts when minting with too low or too high msg.value during public sale', async () => {
      await mintAllFromPresale()

      await expect(contract.connect(accounts[0]).mint({value: utils.parseEther('0.01')})).to.be.revertedWith("MerkleNFT: invalid amount of ether sent")
      await expect(contract.connect(accounts[0]).mint({value: utils.parseEther('0.2')})).to.be.revertedWith("MerkleNFT: invalid amount of ether sent")
    })
    
    it('changes stage from PUBLIC_SALE to SUPPLY_RUN_OUT after max supply is reached', async () => {
      expect(await contract.stage()).to.be.equal(Stages.PRESALE)
      
      await mintAllFromPresale()
      
      expect(await contract.stage()).to.be.equal(Stages.PUBLIC_SALE)
      
      for(let i = 0; i < MAX_SUPPLY - accounts.length; i++ ){
        const tx = await contract.connect(accounts[i]).mint({value: PUBLIC_SALE_PRICE})
        await tx.wait()
      }

      expect(await contract.stage()).to.be.equal(Stages.SUPPLY_RUN_OUT)
    })

    it('reverts if user tries to mint (regular mint) after max supply is reached', async () => {
      expect(await contract.stage()).to.be.equal(Stages.PRESALE)
      
      await mintAllFromPresale()
      
      expect(await contract.stage()).to.be.equal(Stages.PUBLIC_SALE)
      
      for(let i = 0; i < MAX_SUPPLY - accounts.length; i++ ){
        const tx = await contract.connect(accounts[i]).mint({value: PUBLIC_SALE_PRICE})
        await tx.wait()
      }

      await expect(contract.connect(accounts[0]).mint({value: PUBLIC_SALE_PRICE})).to.be.revertedWith("MerkleNFT: invalid stage")

    })

    it('transfers multiple nfts with multicall', async () => {
      
      await mintAllFromPresale()

      expect(await contract.balanceOf(addresses[0])).to.be.equal(1)
      expect(await contract.balanceOf(addresses[1])).to.be.equal(1)
      
      const mintTx = await contract.connect(accounts[0]).mint({value: PUBLIC_SALE_PRICE})
      await mintTx.wait()

      expect(await contract.balanceOf(addresses[0])).to.be.equal(2)
      expect(await contract.balanceOf(addresses[1])).to.be.equal(1)

      const transferFromSignature = await contract.getTransferFromSignature(addresses[0], addresses[1], 0)
      const transferFromSignature2 = await contract.getTransferFromSignature(addresses[0], addresses[1], 20)

      const tx = await contract.connect(accounts[0]).transferMany([transferFromSignature, transferFromSignature2])
      await tx.wait()

      expect(await contract.balanceOf(addresses[0])).to.be.equal(0)
      expect(await contract.balanceOf(addresses[1])).to.be.equal(3)

    })

   
  })

  describe('Minting with bitmap', async()=>{
    beforeEach(async()=>{
      leaves = addresses.map((address, i) => utils.solidityKeccak256(['address', 'uint256'], [address, i]))  
      merkleTree = new MerkleTree(leaves, utils.keccak256, {sortPairs: true})
      root = merkleTree.getRoot()
      const hexRoot = utils.hexValue(root) 
  
      const ContractFactory = await ethers.getContractFactory('MerkleNFT')
      contract = await ContractFactory.deploy(NAME, SYMBOL, hexRoot)
      await contract.deployed()
    })

    it('mints properly during presale', async () => {
      expect(await contract.stage()).to.be.equal(0)
      for(let i = 0; i < accounts.length; i++){
        const proof = generateProof(i);

        const tx = await contract.connect(accounts[i]).mintWithBitmap(proof, i, {value: PRESALE_PRICE})
        await tx.wait()
      }

      expect(await contract.stage()).to.be.equal(1)
    })
  })

})
