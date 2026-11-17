// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuctionEscrow} from "../contracts/AuctionEscrow.sol";
import {MockUSDC} from "../contracts/mocks/MockUSDC.sol";

contract AuctionEscrowTest is Test {
    AuctionEscrow escrow;
    MockUSDC usdc;

    address constant OWNER = address(0x1);
    address constant AUCTIONEER = address(0x2);
    address constant SELLER = address(0x3);
    address constant BIDDER_A = address(0xA1);
    address constant BIDDER_B = address(0xB2);

    uint256 constant LOT = 7;
    uint96 constant BID_A = 20_000_000; // 20 USDC (6 decimals)
    uint96 constant BID_B = 25_000_000; // 25 USDC

    function setUp() public {
        vm.startPrank(OWNER);
        usdc = new MockUSDC();
        escrow = new AuctionEscrow(address(usdc), AUCTIONEER);
        vm.stopPrank();

        usdc.mint(BIDDER_A, 1_000_000_000);
        usdc.mint(BIDDER_B, 1_000_000_000);
        vm.prank(BIDDER_A);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(BIDDER_B);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ---- happy path ----

    function test_FirstBidLocksFunds() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);

        (address bidder, uint96 amount, address seller) = escrow.getHighestBid(LOT);
        assertEq(bidder, BIDDER_A);
        assertEq(amount, BID_A);
        assertEq(seller, SELLER);
        assertEq(usdc.balanceOf(address(escrow)), BID_A);
        assertEq(usdc.balanceOf(BIDDER_A), 1_000_000_000 - BID_A);
    }

    function test_OutbidRefundsPreviousBidderImmediately() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);
        uint256 aBefore = usdc.balanceOf(BIDDER_A);

        vm.prank(BIDDER_B);
        escrow.placeBid(LOT, BID_B, SELLER);

        assertEq(usdc.balanceOf(BIDDER_A), aBefore + BID_A);
        (address bidder, uint96 amount, ) = escrow.getHighestBid(LOT);
        assertEq(bidder, BIDDER_B);
        assertEq(amount, BID_B);
        assertEq(usdc.balanceOf(address(escrow)), BID_B);
    }

    function test_SelfRaiseNetsCorrectly() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);
        uint256 aBefore = usdc.balanceOf(BIDDER_A);

        uint96 raised = BID_A + 10_000_000;
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, raised, SELLER);

        assertEq(usdc.balanceOf(BIDDER_A), aBefore - 10_000_000);
        assertEq(usdc.balanceOf(address(escrow)), raised);
    }

    function test_SettlePaysRecordedSeller() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);
        vm.prank(AUCTIONEER);
        escrow.settle(LOT);

        assertTrue(escrow.isSettled(LOT));
        assertEq(usdc.balanceOf(SELLER), BID_A);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    // ---- reverts / guardrails ----

    function test_RevertIfBidNotHigher() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);
        vm.prank(BIDDER_B);
        vm.expectRevert(AuctionEscrow.BidNotHigher.selector);
        escrow.placeBid(LOT, BID_A, SELLER);
    }

    function test_RevertIfZeroAmount() public {
        vm.prank(BIDDER_A);
        vm.expectRevert(AuctionEscrow.ZeroAmount.selector);
        escrow.placeBid(LOT, 0, SELLER);
    }

    function test_RevertIfSellerChanges() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);
        vm.prank(BIDDER_B);
        vm.expectRevert(AuctionEscrow.SellerMismatch.selector);
        escrow.placeBid(LOT, BID_B, address(0x9));
    }

    function test_RevertIfNotAuctioneerSettles() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);
        vm.prank(BIDDER_B);
        vm.expectRevert(AuctionEscrow.NotAuctioneer.selector);
        escrow.settle(LOT);
    }

    function test_RevertNativeUSDCSend() public {
        vm.expectRevert("native USDC not accepted; use ERC-20 interface");
        address(escrow).call{value: 1}("");
    }

    function test_DecimalsIsSix() public {
        assertEq(usdc.decimals(), 6);
    }

    // ---- refund failure fallback (M1) ----

    function test_RefundFailureQueuesCreditNotRevert() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);

        vm.mockCallRevert(
            address(usdc),
            abi.encodeWithSelector(usdc.transfer.selector, BIDDER_A, BID_A),
            bytes("blocked")
        );

        vm.prank(BIDDER_B);
        escrow.placeBid(LOT, BID_B, SELLER); // must NOT revert

        assertEq(escrow.refundCredit(BIDDER_A), BID_A);
        assertEq(usdc.balanceOf(address(escrow)), BID_A + BID_B);
        (address bidder, , ) = escrow.getHighestBid(LOT);
        assertEq(bidder, BIDDER_B);
    }

    function test_ClaimQueuedRefund() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);
        vm.mockCallRevert(
            address(usdc),
            abi.encodeWithSelector(usdc.transfer.selector, BIDDER_A, BID_A),
            bytes("blocked")
        );
        vm.prank(BIDDER_B);
        escrow.placeBid(LOT, BID_B, SELLER);
        vm.clearMockedCalls();

        uint256 before = usdc.balanceOf(BIDDER_A);
        vm.prank(BIDDER_A);
        escrow.claimRefund();
        assertEq(usdc.balanceOf(BIDDER_A), before + BID_A);
        assertEq(escrow.refundCredit(BIDDER_A), 0);
    }

    // ---- key rotation / emergency refund (M3) ----

    function test_SetAuctioneerAndEmergencyRefund() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);

        vm.prank(OWNER);
        escrow.setAuctioneer(address(0x8));
        assertEq(escrow.auctioneer(), address(0x8));

        vm.warp(block.timestamp + 25 hours);
        uint256 before = usdc.balanceOf(BIDDER_A);
        vm.prank(OWNER);
        escrow.emergencyRefund(LOT);
        assertEq(usdc.balanceOf(BIDDER_A), before + BID_A);
        assertTrue(escrow.isSettled(LOT));
    }

    function test_EmergencyRefundBeforeWindowReverts() public {
        vm.prank(BIDDER_A);
        escrow.placeBid(LOT, BID_A, SELLER);
        vm.prank(OWNER);
        vm.expectRevert(AuctionEscrow.WindowOpen.selector);
        escrow.emergencyRefund(LOT);
    }
}
