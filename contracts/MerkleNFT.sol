// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "hardhat/console.sol";

contract MerkleNFT is ERC721 {
    using Strings for uint256;
    using BitMaps for BitMaps.BitMap;

     enum Stages {
        PRESALE,
        PUBLIC_SALE,
        SUPPLY_RUN_OUT
    }

    struct Commit {
        bytes32 commitHash;
        uint256 minRevealBlock;
        bool revealed;
    }

    uint256 constant public MAX_SUPPLY = 30;
    uint256 constant public PRESALE_SUPPLY = 20;
    uint256 constant public PRESALE_PRICE = 0.001 ether;  
    uint256 constant public PUBLIC_SALE_PRICE = 0.1 ether;  
    uint256 constant public MIN_REVEAL_PERIOD = 10;  
    uint256 public tokenIdShift;
    uint256 tokenSupply;

    mapping(address => uint) deposits;
    mapping(address => bool) public addressMinted;
    bytes32 immutable private root;
    BitMaps.BitMap private hasMintedBitmap;
    address public owner;
    Stages public stage = Stages.PRESALE;
    Commit public commit1;


    constructor(string memory name, string memory symbol, bytes32 _root) ERC721(name, symbol){
        owner = msg.sender;
        root = _root;

        for(uint256 i =0; i < PRESALE_SUPPLY; i++){
            hasMintedBitmap.set(i);
        }
    }

    modifier onlyOwner(){
        require(msg.sender == owner, "MerkleNFT: only owner");
        _;
    }

    modifier atStage(Stages _stage) {
        require(stage == _stage, "MerkleNFT: invalid stage");
        _;
    }

    function tokenURI(uint _tokenId) public view override returns (string memory){
        if(commit1.revealed){
            // After reveal every tokenId is shifted by tokenIdShift
            // tokenId = 25, tokenIdShift = 10, MAX_SUPPLY = 30, shiftedTokenId = 5
            uint256 shiftedTokenId = (_tokenId + tokenIdShift) % MAX_SUPPLY;
            return string(abi.encodePacked(_baseURI(), shiftedTokenId.toString()));
        }else{
            return string(abi.encodePacked(_baseURI(), 'PLACEHOLDER'));
        }
    }

    function _baseURI() internal pure override returns (string memory) {
        return "ipfs://Qmd2mBHk76jYjA2UMYqdfM9YaW1oZBycZzchznyKUEiHBV/";
    }

    function commit(bytes32 commitHash) external onlyOwner {
        require(commit1.minRevealBlock == 0, "MerkleNFT: already commited");
        commit1.commitHash = commitHash;
        commit1.minRevealBlock = block.number + MIN_REVEAL_PERIOD;
    }

    function reveal(uint256 shift, uint salt) external onlyOwner {
        require(commit1.minRevealBlock != 0, "MerkleNFT: not commited yet");
        require(commit1.revealed == false, "MerkleNFT: commit already revealed");
        require(block.number >= commit1.minRevealBlock, "MerkleNFT: cannot reveal yet");
        require(commit1.commitHash == createSaltedHash(shift, salt), "MerkleNFT: invalid hash");
        commit1.revealed = true;
        tokenIdShift = shift;
    }

      function createSaltedHash(uint256 shift, uint salt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(shift, salt));
    }

    function mintWithMapping(bytes32[] calldata proof, bytes32 leaf) external payable atStage(Stages.PRESALE) {
        require(msg.value == PRESALE_PRICE, "MerkleNFT: invalid amount of ether sent");

        _verifyWithMapping(proof, leaf);

        require(!addressMinted[msg.sender], "MerkleNFT: user has already minted");
        addressMinted[msg.sender] = true;

        _mint(msg.sender, tokenSupply);
        tokenSupply++;

        if(tokenSupply == PRESALE_SUPPLY){
            nextStage();
        }
    } 

    function _verifyWithMapping(bytes32[] calldata proof, bytes32 leaf) private view {
        require(MerkleProof.verify(proof, root, leaf), "MerkleNFT: not allowed to mint");
    }

    function mintWithBitmap(bytes32[] calldata proof, uint256 index) external payable atStage(Stages.PRESALE) {
        require(msg.value == PRESALE_PRICE, "MerkleNFT: invalid amount of ether sent");

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, index));
        _verifyWithBitmap(proof, leaf);

        require(hasMintedBitmap.get(index), "MerkleNFT: user has already minted");
        hasMintedBitmap.unset(index);

        _mint(msg.sender, tokenSupply);
        tokenSupply++;

        if(tokenSupply == PRESALE_SUPPLY){
            nextStage();
        }
    }

    function _verifyWithBitmap(bytes32[] calldata proof,  bytes32 leaf) private view {
        require(MerkleProof.verify(proof, root, leaf), "MerkleNFT: not allowed to mint");
    }

    // MULTICALL
    function transferMany(bytes[] calldata data) external returns (bytes[] memory){
        bytes4 transferFromSelector = this.transferFrom.selector;
        bytes[] memory results = new bytes[](data.length);

        for(uint256 i = 0; i < data.length; i++){
            require(transferFromSelector == bytes4(data[i]), "MerkleNFT: this method is not approved");
            (bool success, bytes memory result) = address(this).delegatecall(data[i]);
            require(success, "MerkleNFT: call failed");
            results[i] = result;
        }

        return results;
    }

    function getTransferFromSignature(address from, address to, uint256 _tokenId) external pure returns (bytes memory) {
        return abi.encodeWithSelector(this.transferFrom.selector, from, to, _tokenId);
    }

      function mint()
        public
        payable
        atStage(Stages.PUBLIC_SALE)
    {
        require(msg.value == PUBLIC_SALE_PRICE, "MerkleNFT: invalid amount of ether sent");

        _mint(msg.sender, tokenSupply);
        tokenSupply++;

         if(tokenSupply == MAX_SUPPLY){
            nextStage();
        }
    }

    function nextStage() internal {
        stage = Stages(uint(stage) + 1);
    }

    function allowForPull(address receiver, uint amount) external onlyOwner {
        deposits[receiver] += amount;
    }

    function pullDeposit() external {
        uint amount = deposits[msg.sender];

        require(amount != 0);
        require(address(this).balance >= amount);

        deposits[msg.sender] = 0;

        payable(msg.sender).transfer(amount);
    }

    function withdraw() external onlyOwner {
        (bool success, ) = payable(msg.sender).call{value: address(this).balance}("");
        require(success, "MerkleNFT: withdrawal failed");
    }

    receive() external payable {}
}