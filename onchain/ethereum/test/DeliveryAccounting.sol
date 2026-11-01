pragma solidity 0.8.38;

import {NFT111K} from "../src/NFT111K.sol";

library DeliveryAccounting {
    function config(NFT111K token, uint256 id) internal view returns (NFT111K.DeliveryConfig memory value) {
        (value.receiver1, value.receiver2, value.receiver2Bps, value.totalReceived, value.released1, value.released2) =
            token.deliveryConfigs(id);
    }

    function received(NFT111K token) internal view returns (uint256 total) {
        for (uint256 id = 1; id <= token.deliveryConfigCount(); ++id) {
            total += config(token, id).totalReceived;
        }
    }

    function released(NFT111K token) internal view returns (uint256 total) {
        for (uint256 id = 1; id <= token.deliveryConfigCount(); ++id) {
            NFT111K.DeliveryConfig memory value = config(token, id);
            total += value.released1 + value.released2;
        }
    }

    function pending(NFT111K token, address receiver) internal view returns (uint256 total) {
        for (uint256 id = 1; id <= token.deliveryConfigCount(); ++id) {
            NFT111K.DeliveryConfig memory value = config(token, id);
            uint256 secondary = (value.totalReceived / 10_000) * value.receiver2Bps
                + ((value.totalReceived % 10_000) * value.receiver2Bps) / 10_000;
            if (value.receiver1 == receiver) total += value.totalReceived - secondary - value.released1;
            if (value.receiver2 == receiver) total += secondary - value.released2;
        }
    }

    function release(NFT111K token, address receiver) internal {
        for (uint256 id = 1; id <= token.deliveryConfigCount(); ++id) {
            NFT111K.DeliveryConfig memory value = config(token, id);
            if (value.receiver1 == receiver) token.releaseDeliveryFor(id, false);
            if (value.receiver2 == receiver) token.releaseDeliveryFor(id, true);
        }
    }

    function ensureSingle(NFT111K token, address receiver) internal returns (uint256) {
        for (uint256 id = 1; id <= token.deliveryConfigCount(); ++id) {
            NFT111K.DeliveryConfig memory value = config(token, id);
            if (value.receiver1 == receiver && value.receiver2 == address(0)) return id;
        }
        return token.registerDeliveryConfig(receiver, address(0), 0);
    }
}
