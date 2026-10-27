pragma solidity 0.8.30;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {INFT111KRenderer} from "./INFT111KRenderer.sol";

contract NFT111KUrlRenderer is INFT111KRenderer {
    using Strings for uint256;

    string public baseURI;

    error InvalidBaseURI();
    error InvalidItem();

    constructor(string memory baseURI_) {
        bytes memory value = bytes(baseURI_);
        if (value.length < 9 || value[value.length - 1] != "/") revert InvalidBaseURI();
        bool secure = value[0] == "h" && value[1] == "t" && value[2] == "t" && value[3] == "p" && value[4] == "s"
            && value[5] == ":" && value[6] == "/" && value[7] == "/";
        bool local = block.chainid == 31337 && value[0] == "h" && value[1] == "t" && value[2] == "t" && value[3] == "p"
            && value[4] == ":" && value[5] == "/" && value[6] == "/";
        if ((!secure && !local) || value[secure ? 8 : 7] == "/") revert InvalidBaseURI();
        for (uint256 i; i < value.length; ++i) {
            if (
                uint8(value[i]) <= 32 || uint8(value[i]) >= 127 || value[i] == "?" || value[i] == "#"
                    || value[i] == "\\" || value[i] == "@"
            ) revert InvalidBaseURI();
        }
        baseURI = baseURI_;
    }

    function tokenURI(uint8 kind, uint256 displayId) external view returns (string memory) {
        if (displayId == 0) revert InvalidItem();
        uint256 tokenId;
        if (kind == 1 && displayId <= 111_111) tokenId = displayId;
        else if (kind == 2 && displayId <= 5_555) tokenId = 111_111 + displayId;
        else if (kind == 3 && displayId <= 505) tokenId = 116_666 + displayId;
        else if (kind == 4 && displayId <= 222_222) tokenId = 1_000_000 + displayId;
        else if (kind == 5 && displayId <= 5_555) tokenId = 2_000_000 + displayId;
        else revert InvalidItem();
        return string.concat(baseURI, tokenId.toString(), ".json");
    }
}
