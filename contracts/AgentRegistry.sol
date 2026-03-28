// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentRegistry
 * @notice On-chain agent identity and reputation registry for agentic commerce
 *         on TRON. Goes beyond ERC-8004 with mutable, gateway-attested reputation.
 *
 * Agents self-register with a metadata URI (IPFS/HTTP) pointing to their profile.
 * The gateway (owner) updates reputation scores after verified transactions.
 */
contract AgentRegistry {
    // ── Types ────────────────────────────────────────────────────────────────

    struct Agent {
        string   metadataURI;
        int256   reputation;
        uint256  registeredBlock;
        bool     registered;
        uint256  totalTransactions;
    }

    // ── State ────────────────────────────────────────────────────────────────

    address public owner;
    uint256 public totalAgents;

    mapping(address => Agent) public agents;
    address[] public agentList;

    // ── Events ───────────────────────────────────────────────────────────────

    event AgentRegistered(address indexed agent, string metadataURI, uint256 registeredBlock);
    event MetadataUpdated(address indexed agent, string newURI);
    event ReputationUpdated(address indexed agent, int256 newReputation, int16 delta);
    event TransactionRecorded(address indexed agent, uint256 totalTransactions);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    // ── Agent self-service ───────────────────────────────────────────────────

    /**
     * Register the caller as an agent with a metadata URI.
     * @param metadataURI  IPFS hash or HTTP URL pointing to agent profile JSON.
     */
    function registerAgent(string calldata metadataURI) external {
        require(!agents[msg.sender].registered, "already registered");
        require(bytes(metadataURI).length > 0, "empty URI");

        agents[msg.sender] = Agent({
            metadataURI: metadataURI,
            reputation: 0,
            registeredBlock: block.number,
            registered: true,
            totalTransactions: 0
        });
        agentList.push(msg.sender);
        totalAgents++;

        emit AgentRegistered(msg.sender, metadataURI, block.number);
    }

    /**
     * Update the caller's metadata URI.
     */
    function updateMetadata(string calldata newURI) external {
        require(agents[msg.sender].registered, "not registered");
        require(bytes(newURI).length > 0, "empty URI");

        agents[msg.sender].metadataURI = newURI;
        emit MetadataUpdated(msg.sender, newURI);
    }

    // ── Owner (gateway) actions ──────────────────────────────────────────────

    /**
     * Update an agent's reputation score. Only callable by the gateway/owner.
     * @param agent  The agent address.
     * @param delta  Reputation change (positive or negative).
     */
    function updateReputation(address agent, int16 delta) external onlyOwner {
        require(agents[agent].registered, "agent not registered");

        agents[agent].reputation += delta;
        emit ReputationUpdated(agent, agents[agent].reputation, delta);
    }

    /**
     * Record a completed transaction for an agent. Only callable by the gateway/owner.
     */
    function recordTransaction(address agent) external onlyOwner {
        require(agents[agent].registered, "agent not registered");

        agents[agent].totalTransactions++;
        emit TransactionRecorded(agent, agents[agent].totalTransactions);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function getAgent(address agent) external view returns (
        string memory metadataURI,
        int256 reputation,
        uint256 registeredBlock,
        bool registered,
        uint256 totalTransactions
    ) {
        Agent storage a = agents[agent];
        return (a.metadataURI, a.reputation, a.registeredBlock, a.registered, a.totalTransactions);
    }

    function isRegistered(address agent) external view returns (bool) {
        return agents[agent].registered;
    }

    function getAgentCount() external view returns (uint256) {
        return totalAgents;
    }

    function getAgentAtIndex(uint256 index) external view returns (address) {
        require(index < agentList.length, "out of bounds");
        return agentList[index];
    }
}
