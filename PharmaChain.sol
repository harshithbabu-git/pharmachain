// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PharmaChain v2
/// @notice Pharmaceutical supply-chain integrity on a public ledger:
///         - a regulator-controlled role registry (manufacturer / distributor / pharmacy)
///         - many batches, each with a hash-anchored QC certificate
///         - a full custody history and temperature log per batch
///         - automatic cold-chain breach detection (too warm OR too cold)
///         - regulator recall
///         - free public verification of any batch
contract PharmaChain {
    address public regulator;

    enum Role { None, Manufacturer, Distributor, Pharmacy }
    enum Status { Unregistered, AwaitingCertification, Certified, ColdChainBreached, Recalled, Delivered }

    struct Batch {
        string label;            // human-readable lot, e.g. "PFZ-2201 | Rotavirus Vaccine"
        address manufacturer;
        bytes32 qcCertHash;      // keccak256 of the QC certificate (document stays off-chain)
        address currentHolder;
        int256 minSafeTemp;      // tenths of a degree C (20 = 2.0 C)
        int256 maxSafeTemp;      // tenths of a degree C (80 = 8.0 C)
        Status status;
        uint256 registeredAt;
    }

    struct CustodyRecord {
        address holder;
        uint256 timestamp;
    }

    struct TempRecord {
        int256 reading;          // tenths of a degree C
        uint256 timestamp;
        address reporter;
    }

    mapping(address => Role) public roles;
    mapping(bytes32 => Batch) private batches;
    mapping(bytes32 => CustodyRecord[]) private custody;
    mapping(bytes32 => TempRecord[]) private temps;
    bytes32[] private batchIds;

    event RoleSet(address indexed account, Role role);
    event BatchRegistered(bytes32 indexed batchId, address indexed manufacturer, string label, bytes32 qcCertHash);
    event BatchCertified(bytes32 indexed batchId, address indexed regulator);
    event CustodyTransferred(bytes32 indexed batchId, address indexed from, address indexed to, uint256 timestamp);
    event TemperatureLogged(bytes32 indexed batchId, int256 reading, address indexed reporter, uint256 timestamp);
    event ColdChainBreach(bytes32 indexed batchId, int256 reading, int256 minSafeTemp, int256 maxSafeTemp);
    event BatchDelivered(bytes32 indexed batchId, address indexed pharmacy);
    event BatchRecalled(bytes32 indexed batchId, string reason);

    modifier onlyRegulator() {
        require(msg.sender == regulator, "PharmaChain: caller is not the regulator");
        _;
    }

    constructor(address _regulator) {
        regulator = _regulator;
    }

    // ------------------------------------------------------------------
    // Role registry (regulator only)
    // ------------------------------------------------------------------

    /// @notice The regulator whitelists (or removes) a participant.
    function setRole(address account, Role role) external onlyRegulator {
        require(account != address(0), "PharmaChain: zero address");
        roles[account] = role;
        emit RoleSet(account, role);
    }

    // ------------------------------------------------------------------
    // Batch lifecycle
    // ------------------------------------------------------------------

    /// @notice A whitelisted manufacturer registers a batch. It starts as
    ///         AwaitingCertification and cannot move until the regulator certifies it.
    function registerBatch(
        bytes32 batchId,
        string calldata label,
        bytes32 qcCertHash,
        int256 minSafeTemp,
        int256 maxSafeTemp
    ) external {
        require(roles[msg.sender] == Role.Manufacturer, "PharmaChain: caller is not an authorised manufacturer");
        require(batches[batchId].status == Status.Unregistered, "PharmaChain: batch already registered");
        require(qcCertHash != bytes32(0), "PharmaChain: cert hash required");
        require(minSafeTemp < maxSafeTemp, "PharmaChain: invalid temperature range");

        batches[batchId] = Batch({
            label: label,
            manufacturer: msg.sender,
            qcCertHash: qcCertHash,
            currentHolder: msg.sender,
            minSafeTemp: minSafeTemp,
            maxSafeTemp: maxSafeTemp,
            status: Status.AwaitingCertification,
            registeredAt: block.timestamp
        });
        custody[batchId].push(CustodyRecord(msg.sender, block.timestamp));
        batchIds.push(batchId);

        emit BatchRegistered(batchId, msg.sender, label, qcCertHash);
    }

    /// @notice Regulator certifies a batch, unlocking custody transfers.
    function certifyBatch(bytes32 batchId) external onlyRegulator {
        Batch storage b = batches[batchId];
        require(b.status == Status.AwaitingCertification, "PharmaChain: batch not awaiting certification");

        b.status = Status.Certified;
        emit BatchCertified(batchId, msg.sender);
    }

    /// @notice The current holder hands the batch to an authorised distributor or
    ///         pharmacy. Handing it to a pharmacy completes delivery.
    function transferCustody(bytes32 batchId, address newHolder) external {
        Batch storage b = batches[batchId];
        require(b.status == Status.Certified, "PharmaChain: batch not certified or chain is broken");
        require(msg.sender == b.currentHolder, "PharmaChain: caller does not hold this batch");
        require(newHolder != msg.sender, "PharmaChain: cannot transfer to yourself");

        Role r = roles[newHolder];
        require(
            r == Role.Distributor || r == Role.Pharmacy,
            "PharmaChain: recipient is not an authorised distributor or pharmacy"
        );

        address from = b.currentHolder;
        b.currentHolder = newHolder;
        custody[batchId].push(CustodyRecord(newHolder, block.timestamp));
        emit CustodyTransferred(batchId, from, newHolder, block.timestamp);

        if (r == Role.Pharmacy) {
            b.status = Status.Delivered;
            emit BatchDelivered(batchId, newHolder);
        }
    }

    /// @notice Logs a cold-chain sensor reading (tenths of a degree C). A reading
    ///         outside the batch's safe range flips it to ColdChainBreached, which
    ///         blocks any further transfer.
    function logTemperature(bytes32 batchId, int256 reading) external {
        Batch storage b = batches[batchId];
        require(b.status == Status.Certified, "PharmaChain: batch not in a loggable state");
        require(
            msg.sender == b.currentHolder || msg.sender == regulator,
            "PharmaChain: only the current holder or regulator can log readings"
        );

        temps[batchId].push(TempRecord(reading, block.timestamp, msg.sender));
        emit TemperatureLogged(batchId, reading, msg.sender, block.timestamp);

        if (reading > b.maxSafeTemp || reading < b.minSafeTemp) {
            b.status = Status.ColdChainBreached;
            emit ColdChainBreach(batchId, reading, b.minSafeTemp, b.maxSafeTemp);
        }
    }

    /// @notice Regulator recalls a batch at any point, freezing it permanently.
    function recallBatch(bytes32 batchId, string calldata reason) external onlyRegulator {
        Batch storage b = batches[batchId];
        require(b.status != Status.Unregistered, "PharmaChain: batch does not exist");
        require(b.status != Status.Recalled, "PharmaChain: already recalled");

        b.status = Status.Recalled;
        emit BatchRecalled(batchId, reason);
    }

    // ------------------------------------------------------------------
    // Free public reads (anyone can verify)
    // ------------------------------------------------------------------

    function getBatch(bytes32 batchId) external view returns (Batch memory) {
        return batches[batchId];
    }

    function getCustodyHistory(bytes32 batchId) external view returns (CustodyRecord[] memory) {
        return custody[batchId];
    }

    function getTemperatureLog(bytes32 batchId) external view returns (TempRecord[] memory) {
        return temps[batchId];
    }

    function getAllBatchIds() external view returns (bytes32[] memory) {
        return batchIds;
    }

    function getBatchCount() external view returns (uint256) {
        return batchIds.length;
    }
}