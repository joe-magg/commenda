// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Minimal auction escrow for Arc testnet (USDC ERC-20, 6 decimals at
 * 0x3600000000000000000000000000000000000000).
 *
 * Flow: placeBid locks funds -> an outbid is refunded immediately (push, with
 * a pull-credit fallback) -> settle pays the seller recorded at bid time.
 *
 * AUDIT FIXES INCORPORATED (see ESCROW_DESIGN.md):
 *   M1: refund failure queues a credit instead of reverting the whole bid.
 *   M2: seller is bound at first bid and reused by settle (allowlist is real).
 *   M3: owner can rotate the auctioneer key; emergency refund after a window.
 *   L2: zero-amount check first, self-raise is a net delta at event ingestion.
 *   L3: no dead lot registry; lot validity is off-chain, seller binds the lot.
 *   L4: constructor asserts 6 decimals; native USDC sends revert.
 */
interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

contract AuctionEscrow {
    IERC20Min public immutable USDC;
    address public owner;
    address public auctioneer;

    struct Bid {
        address bidder;
        uint96 amount; // USDC minor units (6 decimals)
        address seller;
    }

    mapping(uint256 lotId => Bid) public highestBid;
    mapping(uint256 lotId => bool) public settled;
    mapping(uint256 lotId => uint64) public lotOpenedAt;
    mapping(address bidder => uint256) public refundCredit;

    uint64 public constant SETTLEMENT_WINDOW = 24 hours;

    event BidPlaced(
        uint256 indexed lotId,
        address indexed bidder,
        uint96 amount,
        address indexed prevBidder,
        uint96 prevAmount,
        address seller
    );
    event RefundQueued(address indexed bidder, uint256 amount);
    event RefundClaimed(address indexed bidder, uint256 amount);
    event LotSettled(uint256 indexed lotId, address indexed bidder, uint96 amount, address indexed seller);
    event EmergencyRefund(uint256 indexed lotId, address indexed bidder, uint96 amount);
    event AuctioneerChanged(address oldAuctioneer, address newAuctioneer);

    error ZeroAddress();
    error ZeroAmount();
    error LotAlreadySettled();
    error BidNotHigher();
    error SellerMismatch();
    error TransferInFailed();
    error NoBids();
    error TransferOutFailed();
    error NotAuctioneer();
    error NotOwner();
    error NoRefund();
    error WindowOpen();
    error WrongDecimals();

    // Minimal reentrancy guard (no external dependency).
    uint256 private _locked = 1;

    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier onlyAuctioneer() {
        if (msg.sender != auctioneer) revert NotAuctioneer();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdc_, address auctioneer_) {
        if (usdc_ == address(0) || auctioneer_ == address(0)) revert ZeroAddress();
        USDC = IERC20Min(usdc_);
        if (USDC.decimals() != 6) revert WrongDecimals(); // L4
        auctioneer = auctioneer_;
        owner = msg.sender;
    }

    // Arc docs: native USDC sends bypass ERC-20 allowances. Reject them.
    receive() external payable {
        revert("native USDC not accepted; use ERC-20 interface");
    }

    fallback() external payable {
        revert("unknown selector");
    }

    /**
     * Place a bid. Seller is fixed at the first bid for a lot and cannot change
     * (M2) — the agent's sellerAllowlist guardrail therefore has on-chain force.
     */
    function placeBid(uint256 lotId, uint96 amount, address seller) external nonReentrant {
        if (amount == 0) revert ZeroAmount(); // L2: correct reason first
        if (seller == address(0)) revert ZeroAddress();
        if (settled[lotId]) revert LotAlreadySettled();

        Bid storage h = highestBid[lotId];
        if (amount <= h.amount) revert BidNotHigher();

        if (h.bidder == address(0)) {
            h.seller = seller;
            lotOpenedAt[lotId] = uint64(block.timestamp);
        } else if (h.seller != seller) {
            revert SellerMismatch();
        }

        // Capture previous bidder as memory BEFORE the write (CEI, no read-after-write).
        address prevBidder = h.bidder;
        uint96 prevAmount = h.amount;
        h.bidder = msg.sender;
        h.amount = amount;

        // Interaction: pull new funds in.
        if (!USDC.transferFrom(msg.sender, address(this), uint256(amount))) {
            revert TransferInFailed();
        }

        // Immediate refund with pull fallback (M1): a failed refund must not
        // freeze the lot or revert the new bid.
        if (prevBidder != address(0)) {
            _refundOrCredit(prevBidder, uint256(prevAmount));
        }

        emit BidPlaced(lotId, msg.sender, amount, prevBidder, prevAmount, h.seller);
    }

    /** Settle a lot: pay the seller recorded at bid time. Auctioneer-only. */
    function settle(uint256 lotId) external nonReentrant onlyAuctioneer {
        if (settled[lotId]) revert LotAlreadySettled();
        Bid memory h = highestBid[lotId];
        if (h.bidder == address(0)) revert NoBids();
        settled[lotId] = true; // effect before interaction
        if (!USDC.transfer(h.seller, uint256(h.amount))) revert TransferOutFailed();
        emit LotSettled(lotId, h.bidder, h.amount, h.seller);
    }

    /** Claim a queued refund (M1 fallback). */
    function claimRefund() external nonReentrant {
        uint256 amount = refundCredit[msg.sender];
        if (amount == 0) revert NoRefund();
        refundCredit[msg.sender] = 0;
        if (!USDC.transfer(msg.sender, amount)) revert TransferOutFailed();
        emit RefundClaimed(msg.sender, amount);
    }

    /** Rotate the auctioneer key if it is lost or compromised (M3). */
    function setAuctioneer(address newAuctioneer) external onlyOwner {
        if (newAuctioneer == address(0)) revert ZeroAddress();
        emit AuctioneerChanged(auctioneer, newAuctioneer);
        auctioneer = newAuctioneer;
    }

    /**
     * Emergency refund of a stuck lot after the settlement window (M3).
     * Owner-only; refunds the current highest bidder, never the seller.
     */
    function emergencyRefund(uint256 lotId) external nonReentrant onlyOwner {
        if (settled[lotId]) revert LotAlreadySettled();
        Bid memory h = highestBid[lotId];
        if (h.bidder == address(0)) revert NoBids();
        if (block.timestamp < lotOpenedAt[lotId] + SETTLEMENT_WINDOW) revert WindowOpen();
        settled[lotId] = true;
        if (!USDC.transfer(h.bidder, uint256(h.amount))) revert TransferOutFailed();
        emit EmergencyRefund(lotId, h.bidder, h.amount);
    }

    function _refundOrCredit(address to, uint256 amount) private {
        // Low-level call handles both a revert and a false return.
        (bool ok, bytes memory data) = address(USDC).call(
            abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount)
        );
        bool returnedTrue = ok && (data.length == 0 || abi.decode(data, (bool)));
        if (returnedTrue) return;
        refundCredit[to] += amount;
        emit RefundQueued(to, amount);
    }

    function getHighestBid(uint256 lotId) external view returns (address bidder, uint96 amount, address seller) {
        Bid memory h = highestBid[lotId];
        return (h.bidder, h.amount, h.seller);
    }

    function isSettled(uint256 lotId) external view returns (bool) {
        return settled[lotId];
    }
}
