pragma solidity 0.8.38;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IDMXRenderer} from "./IDMXRenderer.sol";

contract DMXOffchainRenderer is ERC165, IDMXRenderer {
    using Strings for uint256;

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IDMXRenderer).interfaceId || super.supportsInterface(interfaceId);
    }

    function tokenURI(address, uint256 tokenId) external pure returns (string memory) {
        return string.concat("https://cdn.mons.shop/dmx/", tokenId.toString(), ".json");
    }

    function contractURI(address) external pure returns (string memory) {
        return "https://cdn.mons.shop/dmx/collection.json";
    }
}
