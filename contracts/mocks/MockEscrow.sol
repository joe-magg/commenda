// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/** Minimal escrow stub for ReceiptNFT tests. */
contract MockEscrow {
    bool public settled;
    address public bidder;
    uint96 public amount;
    address public seller;

    function setLot(bool settled_, address bidder_, uint96 amount_, address seller_) external {
        settled = settled_;
        bidder = bidder_;
        amount = amount_;
        seller = seller_;
    }

    function isSettled(uint256) external view returns (bool) {
        return settled;
    }

    function getHighestBid(uint256) external view returns (address, uint96, address) {
        return (bidder, amount, seller);
    }
}
