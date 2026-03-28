// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title EscrowPayment
 * @notice On-chain escrow with time-locked release and dispute resolution for
 *         agentic pay-per-call commerce on TRON. Part of the Nile Commerce Gateway.
 *
 * Flow:
 *   1. Buyer calls createEscrow() with TRX value → funds locked.
 *   2. After lockBlocks elapse the merchant calls claimEscrow() → funds released.
 *   3. If the buyer is unhappy, they call initiateDispute() *before* the lock expires.
 *   4. The arbitrator (gateway server) resolves the dispute by splitting funds.
 */
contract EscrowPayment {
    // ── Types ────────────────────────────────────────────────────────────────

    enum Status { Created, Disputed, Released, Resolved }

    struct Escrow {
        address payable buyer;
        address payable merchant;
        uint256 amount;
        bytes32 serviceId;
        uint256 createdBlock;
        uint16  lockBlocks;
        Status  status;
    }

    // ── State ────────────────────────────────────────────────────────────────

    address public arbitrator;
    uint16  public defaultLockBlocks;
    uint256 public nextEscrowId;

    mapping(uint256 => Escrow) public escrows;

    // ── Events ───────────────────────────────────────────────────────────────

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed buyer,
        address indexed merchant,
        uint256 amount,
        bytes32 serviceId,
        uint16  lockBlocks
    );

    event EscrowReleased(uint256 indexed escrowId, address indexed merchant, uint256 amount);

    event EscrowDisputed(uint256 indexed escrowId, address indexed buyer);

    event EscrowResolved(
        uint256 indexed escrowId,
        uint8   buyerPct,
        uint256 buyerAmount,
        uint256 merchantAmount
    );

    // ── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param _arbitrator  Address that can resolve disputes (typically the gateway server).
     * @param _lockBlocks  Default lock period in blocks (~3 s each on TRON, so 20 ≈ 1 min).
     */
    constructor(address _arbitrator, uint16 _lockBlocks) {
        require(_arbitrator != address(0), "zero arbitrator");
        arbitrator = _arbitrator;
        defaultLockBlocks = _lockBlocks;
    }

    // ── Buyer actions ────────────────────────────────────────────────────────

    /**
     * Create an escrow by depositing TRX.
     * @param serviceId  Keccak hash of the service path (e.g. keccak256("/v1/agent/premium-quote")).
     * @param merchant   Merchant address that receives funds on release.
     */
    function createEscrow(
        bytes32 serviceId,
        address payable merchant
    ) external payable returns (uint256 escrowId) {
        require(msg.value > 0, "zero value");
        require(merchant != address(0), "zero merchant");
        require(merchant != msg.sender, "self escrow");

        escrowId = nextEscrowId++;
        escrows[escrowId] = Escrow({
            buyer: payable(msg.sender),
            merchant: merchant,
            amount: msg.value,
            serviceId: serviceId,
            createdBlock: block.number,
            lockBlocks: defaultLockBlocks,
            status: Status.Created
        });

        emit EscrowCreated(escrowId, msg.sender, merchant, msg.value, serviceId, defaultLockBlocks);
    }

    /**
     * Buyer disputes an escrow before the lock period ends.
     */
    function initiateDispute(uint256 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.buyer == msg.sender, "not buyer");
        require(e.status == Status.Created, "not Created");
        require(block.number <= e.createdBlock + e.lockBlocks, "lock expired");

        e.status = Status.Disputed;
        emit EscrowDisputed(escrowId, msg.sender);
    }

    // ── Merchant actions ─────────────────────────────────────────────────────

    /**
     * Merchant claims funds after the lock period, if no dispute was filed.
     */
    function claimEscrow(uint256 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.merchant == msg.sender, "not merchant");
        require(e.status == Status.Created, "not Created");
        require(block.number > e.createdBlock + e.lockBlocks, "still locked");

        e.status = Status.Released;
        uint256 payout = e.amount;
        e.amount = 0;

        (bool ok, ) = e.merchant.call{value: payout}("");
        require(ok, "transfer failed");

        emit EscrowReleased(escrowId, e.merchant, payout);
    }

    // ── Arbitrator actions ───────────────────────────────────────────────────

    /**
     * Arbitrator resolves a disputed escrow by splitting funds.
     * @param buyerPct Percentage (0-100) of funds returned to buyer; remainder goes to merchant.
     */
    function resolveDispute(uint256 escrowId, uint8 buyerPct) external {
        require(msg.sender == arbitrator, "not arbitrator");
        require(buyerPct <= 100, "pct > 100");

        Escrow storage e = escrows[escrowId];
        require(e.status == Status.Disputed, "not Disputed");

        e.status = Status.Resolved;
        uint256 total = e.amount;
        e.amount = 0;

        uint256 buyerAmt = (total * buyerPct) / 100;
        uint256 merchantAmt = total - buyerAmt;

        if (buyerAmt > 0) {
            (bool ok1, ) = e.buyer.call{value: buyerAmt}("");
            require(ok1, "buyer transfer failed");
        }
        if (merchantAmt > 0) {
            (bool ok2, ) = e.merchant.call{value: merchantAmt}("");
            require(ok2, "merchant transfer failed");
        }

        emit EscrowResolved(escrowId, buyerPct, buyerAmt, merchantAmt);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function getEscrow(uint256 escrowId) external view returns (
        address buyer,
        address merchant,
        uint256 amount,
        bytes32 serviceId,
        uint256 createdBlock,
        uint16  lockBlocks,
        Status  status
    ) {
        Escrow storage e = escrows[escrowId];
        return (e.buyer, e.merchant, e.amount, e.serviceId, e.createdBlock, e.lockBlocks, e.status);
    }

    function isLockExpired(uint256 escrowId) external view returns (bool) {
        Escrow storage e = escrows[escrowId];
        return block.number > e.createdBlock + e.lockBlocks;
    }
}
