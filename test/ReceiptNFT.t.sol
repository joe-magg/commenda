// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReceiptNFT} from "../contracts/ReceiptNFT.sol";
import {MockEscrow} from "../contracts/mocks/MockEscrow.sol";

contract ReceiptNFTTest is Test {
    ReceiptNFT receipt;
    MockEscrow escrow;

    address constant AUCTIONEER = address(0x2);
    address constant WINNER = address(0xA1);
    address constant OTHER = address(0xB2);
    uint256 constant LOT = 7;

    function setUp() public {
        escrow = new MockEscrow();
        vm.prank(AUCTIONEER); // not important; constructor takes explicit args
        receipt = new ReceiptNFT(address(escrow), AUCTIONEER);
        escrow.setLot(true, WINNER, 25_000_000, address(0x3));
    }

    function _uri() internal pure returns (string memory) {
        return "data:application/json;base64,eyJuYW1lIjoiSXRlbSJ9";
    }

    // ---- authority + binding ----

    function test_OnlyAuctioneerCanMint() public {
        vm.prank(OTHER);
        vm.expectRevert(ReceiptNFT.NotAuctioneer.selector);
        receipt.mint(LOT, WINNER, _uri());
    }

    function test_CannotMintToZeroAddress() public {
        vm.prank(AUCTIONEER);
        vm.expectRevert(ReceiptNFT.ZeroAddress.selector);
        receipt.mint(LOT, address(0), _uri());
    }

    function test_CannotMintBeforeSettlement() public {
        escrow.setLot(false, WINNER, 25_000_000, address(0x3));
        vm.prank(AUCTIONEER);
        vm.expectRevert(ReceiptNFT.LotNotSettled.selector);
        receipt.mint(LOT, WINNER, _uri());
    }

    function test_CannotMintToNonWinner() public {
        vm.prank(AUCTIONEER);
        vm.expectRevert(ReceiptNFT.NotWinner.selector);
        receipt.mint(LOT, OTHER, _uri());
    }

    function test_CannotMintTwiceForSameLot() public {
        vm.startPrank(AUCTIONEER);
        receipt.mint(LOT, WINNER, _uri());
        vm.expectRevert(ReceiptNFT.AlreadyMinted.selector);
        receipt.mint(LOT, WINNER, _uri());
        vm.stopPrank();
    }

    function test_UriIsCapped() public {
        string memory huge = new string(8193);
        vm.prank(AUCTIONEER);
        vm.expectRevert(ReceiptNFT.UriTooLong.selector);
        receipt.mint(LOT, WINNER, huge);
    }

    // ---- enumeration + views ----

    function test_MintCreatesOwnedToken() public {
        vm.prank(AUCTIONEER);
        vm.expectEmit(true, true, true, false);
        emit ReceiptNFT.Transfer(address(0), WINNER, 1);
        receipt.mint(LOT, WINNER, _uri());

        assertEq(receipt.balanceOf(WINNER), 1);
        assertEq(receipt.ownerOf(1), WINNER);
        assertEq(receipt.tokenOfOwnerByIndex(WINNER, 0), 1);
        assertEq(receipt.tokenURI(1), _uri());
        assertEq(receipt.mintedForLot(LOT), true);
        assertEq(receipt.totalMinted(), 1);
    }

    function test_ExistenceChecksRevert() public {
        vm.expectRevert(ReceiptNFT.Nonexistent.selector);
        receipt.ownerOf(999);
        vm.expectRevert(ReceiptNFT.Nonexistent.selector);
        receipt.tokenURI(999);
    }

    function test_IndexOutOfBoundsReverts() public {
        vm.expectRevert(ReceiptNFT.IndexOutOfBounds.selector);
        receipt.tokenOfOwnerByIndex(WINNER, 0);
    }

    // ---- soulbound ----

    function test_TransfersAndApprovalsRevert() public {
        vm.startPrank(WINNER);
        vm.expectRevert(ReceiptNFT.Soulbound.selector);
        receipt.transferFrom(WINNER, OTHER, 1);
        vm.expectRevert(ReceiptNFT.Soulbound.selector);
        receipt.safeTransferFrom(WINNER, OTHER, 1);
        vm.expectRevert(ReceiptNFT.Soulbound.selector);
        receipt.approve(OTHER, 1);
        vm.expectRevert(ReceiptNFT.Soulbound.selector);
        receipt.setApprovalForAll(OTHER, true);
        vm.stopPrank();
    }

    function test_LockedAndInterfaces() public {
        vm.prank(AUCTIONEER);
        receipt.mint(LOT, WINNER, _uri());
        assertTrue(receipt.locked(1));
        assertTrue(receipt.supportsInterface(0xb45a3c0e)); // EIP-5192
        assertTrue(receipt.supportsInterface(0x5b5e139f)); // metadata
        assertFalse(receipt.supportsInterface(0x80ac58cd)); // NOT base ERC-721
    }

    function test_RotateAuctioneer() public {
        vm.prank(AUCTIONEER);
        receipt.setAuctioneer(OTHER);
        vm.prank(OTHER);
        receipt.mint(LOT, WINNER, _uri());
        assertEq(receipt.ownerOf(1), WINNER);
    }
}
