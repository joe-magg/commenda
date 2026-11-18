// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Soulbound receipt: a non-transferable right to redeem a physical item won
 * in a flash auction. Minted by the auctioneer only after the escrow confirms
 * the lot is settled, and bound to that lot's actual winner.
 *
 * Testnet demo: receipts are not redeemable for real goods.
 */
interface IEscrow {
    function isSettled(uint256 lotId) external view returns (bool);
    function getHighestBid(uint256 lotId) external view returns (address bidder, uint96 amount, address seller);
}

contract ReceiptNFT {
    error ZeroAddress();
    error NotAuctioneer();
    error LotNotSettled();
    error AlreadyMinted();
    error NotWinner();
    error Nonexistent();
    error IndexOutOfBounds();
    error UriTooLong();
    error Soulbound();
    error NoReceiver();

    string public constant name = "Commenda Receipt";
    string public constant symbol = "CRECPT";

    address public auctioneer;
    IEscrow public immutable escrow;

    uint256 public totalMinted;
    uint256 private _nextId = 1;

    mapping(uint256 => address) private _ownerOf;
    mapping(uint256 => string) private _uriOf;
    mapping(address => uint256[]) private _tokensOf;
    mapping(uint256 => bool) private _mintedForLot;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event AuctioneerChanged(address oldAuctioneer, address newAuctioneer);
    event ReceiptMinted(uint256 indexed tokenId, uint256 indexed lotId, address indexed winner);

    constructor(address escrow_, address auctioneer_) {
        if (escrow_ == address(0) || auctioneer_ == address(0)) revert ZeroAddress();
        escrow = IEscrow(escrow_);
        auctioneer = auctioneer_;
    }

    modifier onlyAuctioneer() {
        if (msg.sender != auctioneer) revert NotAuctioneer();
        _;
    }

    function setAuctioneer(address next) external onlyAuctioneer {
        if (next == address(0)) revert ZeroAddress();
        emit AuctioneerChanged(auctioneer, next);
        auctioneer = next;
    }

    /**
     * Bind mint to an escrow-settled lot and its recorded winner. The URI is a
     * data: URI with JSON metadata and an embedded SVG; length is capped so a
     * mint can never breach block gas limits.
     */
    function mint(uint256 lotId, address to, string calldata uri) external onlyAuctioneer returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        if (!escrow.isSettled(lotId)) revert LotNotSettled();
        if (_mintedForLot[lotId]) revert AlreadyMinted();
        (address winner,,) = escrow.getHighestBid(lotId);
        if (winner != to) revert NotWinner();
        if (bytes(uri).length > 8192) revert UriTooLong();

        tokenId = _nextId++;
        _ownerOf[tokenId] = to;
        _uriOf[tokenId] = uri;
        _tokensOf[to].push(tokenId);
        _mintedForLot[lotId] = true;
        totalMinted++;

        emit Transfer(address(0), to, tokenId);
        emit ReceiptMinted(tokenId, lotId, to);
    }

    // ---- ERC-721 view surface (explicit, existence-checked) ----

    function ownerOf(uint256 tokenId) external view returns (address owner) {
        owner = _ownerOf[tokenId];
        if (owner == address(0)) revert Nonexistent();
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf[tokenId] == address(0)) revert Nonexistent();
        return _uriOf[tokenId];
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _tokensOf[owner].length;
    }

    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256) {
        if (index >= _tokensOf[owner].length) revert IndexOutOfBounds();
        return _tokensOf[owner][index];
    }

    function mintedForLot(uint256 lotId) external view returns (bool) {
        return _mintedForLot[lotId];
    }

    // EIP-5192 soulbound
    function locked(uint256 tokenId) external view returns (bool) {
        if (_ownerOf[tokenId] == address(0)) revert Nonexistent();
        return true;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // EIP-5192 soulbound + ERC-721 metadata. Base ERC-721 is deliberately
        // NOT advertised: transfers are disabled.
        return interfaceId == 0xb45a3c0e || interfaceId == 0x5b5e139f || interfaceId == 0x01ffc9a7;
    }

    // ---- Soulbound: every transfer / approval path reverts ----

    function transferFrom(address, address, uint256) public pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) public pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes memory) public pure {
        revert Soulbound();
    }

    function approve(address, uint256) public pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure {
        revert Soulbound();
    }

    function getApproved(uint256) public pure returns (address) {
        revert NoReceiver();
    }

    function isApprovedForAll(address, address) public pure returns (bool) {
        return false;
    }
}
