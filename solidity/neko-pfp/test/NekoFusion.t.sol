// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.30;

import {IERC721A} from "erc721a/IERC721A.sol";

import {NekoRenderer} from "../src/NekoRenderer.sol";
import {NekoSeaDrop} from "../src/NekoSeaDrop.sol";
import {NekoArt} from "../src/NekoArt.sol";
import {NekoTestBase, TestableNekoSeaDrop} from "./NekoTestBase.sol";

contract NekoFusionTest is NekoTestBase {
    function setUp() public override {
        super.setUp();
        _setRevealed();
    }

    function testMergeBurnsDuplicateAndCombinesMassAndAncestry() public {
        NekoRenderer.Traits memory duplicate = _baseTraits(5, 1);
        generator.setRawTraits(neko.tokenSeed(1), duplicate);
        duplicate.toy = 2;
        generator.setRawTraits(neko.tokenSeed(2), duplicate);

        vm.prank(COLLABORATOR);
        neko.merge(1, 2);

        assertEq(neko.totalSupply(), TEAM_SUPPLY - 1, "merge did not burn consumed token");
        assertEq(neko.fusionMass(1), 2, "merge mass mismatch");
        assertEq(neko.duplicateMergeCount(1), 1, "merge count mismatch");
        assertEq(neko.currentRoot(1), 4665, "ancestry root mismatch");
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        neko.ownerOf(2);
    }

    function testMutationCopiesSelectedPartAndPersistsTraits() public {
        generator.setRawTraits(neko.tokenSeed(1), _baseTraits(5, 1));
        generator.setRawTraits(neko.tokenSeed(2), _baseTraits(7, 2));

        vm.prank(COLLABORATOR);
        neko.mutate(1, 2, 0x0008);

        NekoRenderer.TokenData memory data = neko.tokenData(1);
        assertEq(data.traits.body, 7, "consumed body was not copied");
        assertEq(data.fusionMass, 2, "mutation mass mismatch");
        assertEq(neko.mutationCount(1), 1, "mutation count mismatch");
        assertEq(neko.totalSupply(), TEAM_SUPPLY - 1, "mutation did not burn consumed token");
    }

    function testRejectsSelfMergeAndSelfMutation() public {
        vm.prank(COLLABORATOR);
        vm.expectRevert(NekoArt.CannotMergeTokenWithItself.selector);
        neko.merge(1, 1);

        vm.prank(COLLABORATOR);
        vm.expectRevert(NekoArt.CannotMutateTokenWithItself.selector);
        neko.mutate(1, 1, 1);
    }

    function testRejectsEmptyAndOutOfRangeMutationMasks() public {
        vm.prank(COLLABORATOR);
        vm.expectRevert(abi.encodeWithSelector(NekoArt.InvalidMutationSelectionMask.selector, 0));
        neko.mutate(1, 2, 0);

        vm.prank(COLLABORATOR);
        vm.expectRevert(
            abi.encodeWithSelector(NekoArt.InvalidMutationSelectionMask.selector, 0x2000)
        );
        neko.mutate(1, 2, 0x2000);
    }

    function testChainedMutationAndMergesAccumulateMassCountsAndAncestry() public {
        NekoRenderer.Traits memory survivor = _baseTraits(5, 1);
        NekoRenderer.Traits memory donor = _baseTraits(7, 2);
        NekoRenderer.Traits memory mutated = generator.combine(donor, survivor, 0x0008);
        NekoRenderer.Traits memory firstDuplicate = mutated;
        NekoRenderer.Traits memory secondDuplicate = mutated;
        firstDuplicate.toy = 8;
        secondDuplicate.toy = 9;
        generator.setRawTraits(neko.tokenSeed(1), survivor);
        generator.setRawTraits(neko.tokenSeed(2), donor);
        generator.setRawTraits(neko.tokenSeed(3), firstDuplicate);
        generator.setRawTraits(neko.tokenSeed(4), secondDuplicate);

        vm.prank(COLLABORATOR);
        neko.mutate(1, 2, 0x0008);
        vm.prank(COLLABORATOR);
        neko.merge(1, 3);
        vm.prank(COLLABORATOR);
        neko.merge(1, 4);

        assertEq(neko.totalSupply(), TEAM_SUPPLY - 3, "chain did not burn every consumed token");
        assertEq(neko.fusionMass(1), 4, "chained fusion mass mismatch");
        assertEq(neko.mutationCount(1), 1, "chained mutation count mismatch");
        assertEq(neko.duplicateMergeCount(1), 2, "chained duplicate count mismatch");
        assertEq(neko.currentRoot(1), 4667, "chained ancestry root mismatch");
        assertEq(neko.nextNodeId(), 4668, "next ancestry node mismatch");

        _assertAncestryNode(
            4665, 2, 3, NekoArt.FusionAction.Mutation, 0x0008, "mutation node mismatch"
        );
        _assertAncestryNode(
            4666, 4665, 4, NekoArt.FusionAction.DuplicateMerge, 0, "first merge node mismatch"
        );
        _assertAncestryNode(
            4667, 4666, 5, NekoArt.FusionAction.DuplicateMerge, 0, "second merge node mismatch"
        );
    }

    function testCombiningPreviouslyFusedTreesPreservesBothHistories() public {
        NekoRenderer.Traits memory first = _baseTraits(5, 1);
        NekoRenderer.Traits memory firstDonor = _baseTraits(7, 2);
        NekoRenderer.Traits memory second = _baseTraits(9, 3);
        NekoRenderer.Traits memory secondDuplicate = second;
        secondDuplicate.toy = 4;
        generator.setRawTraits(neko.tokenSeed(1), first);
        generator.setRawTraits(neko.tokenSeed(2), firstDonor);
        generator.setRawTraits(neko.tokenSeed(3), second);
        generator.setRawTraits(neko.tokenSeed(4), secondDuplicate);

        vm.prank(COLLABORATOR);
        neko.mutate(1, 2, 0x0008);
        vm.prank(COLLABORATOR);
        neko.merge(3, 4);
        vm.prank(COLLABORATOR);
        neko.mutate(1, 3, 0x0002);

        assertEq(neko.totalSupply(), TEAM_SUPPLY - 3, "tree combination live supply mismatch");
        assertEq(neko.fusionMass(1), 4, "tree combination mass mismatch");
        assertEq(neko.mutationCount(1), 2, "tree mutation history was not aggregated");
        assertEq(neko.duplicateMergeCount(1), 1, "tree merge history was not aggregated");
        assertEq(neko.currentRoot(1), 4667, "combined tree root mismatch");
        assertEq(neko.currentRoot(3), 4666, "consumed tree root history was erased");
        _assertAncestryNode(
            4667, 4665, 4666, NekoArt.FusionAction.Mutation, 0x0002, "combined tree node mismatch"
        );
    }

    function testPerTokenApprovalsMustCoverBothMergeParticipants() public {
        NekoRenderer.Traits memory duplicate = _baseTraits(5, 1);
        generator.setRawTraits(neko.tokenSeed(1), duplicate);
        generator.setRawTraits(neko.tokenSeed(2), duplicate);

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(NekoArt.MergeCallerNotOwnerNorApproved.selector, 1));
        neko.merge(1, 2);

        vm.prank(COLLABORATOR);
        neko.approve(BOB, 1);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(NekoArt.MergeCallerNotOwnerNorApproved.selector, 2));
        neko.merge(1, 2);

        vm.prank(COLLABORATOR);
        neko.approve(BOB, 2);
        vm.prank(BOB);
        neko.merge(1, 2);

        assertEq(neko.ownerOf(1), COLLABORATOR, "approved merge changed survivor owner");
        assertEq(neko.fusionMass(1), 2, "approved merge mass mismatch");
    }

    function testOperatorApprovalCanMutateBothTokens() public {
        generator.setRawTraits(neko.tokenSeed(1), _baseTraits(5, 1));
        generator.setRawTraits(neko.tokenSeed(2), _baseTraits(7, 2));
        vm.prank(COLLABORATOR);
        neko.setApprovalForAll(BOB, true);

        vm.prank(BOB);
        neko.mutate(1, 2, 0x0008);

        assertEq(neko.ownerOf(1), COLLABORATOR, "operator mutation changed survivor owner");
        assertEq(neko.fusionMass(1), 2, "operator mutation mass mismatch");
    }

    function testPerTokenApprovalsMustCoverBothMutationParticipants() public {
        generator.setRawTraits(neko.tokenSeed(1), _baseTraits(5, 1));
        generator.setRawTraits(neko.tokenSeed(2), _baseTraits(7, 2));

        vm.prank(BOB);
        vm.expectRevert(
            abi.encodeWithSelector(NekoArt.MutationCallerNotOwnerNorApproved.selector, 1)
        );
        neko.mutate(1, 2, 0x0008);

        vm.prank(COLLABORATOR);
        neko.approve(BOB, 1);
        vm.prank(BOB);
        vm.expectRevert(
            abi.encodeWithSelector(NekoArt.MutationCallerNotOwnerNorApproved.selector, 2)
        );
        neko.mutate(1, 2, 0x0008);
    }

    function testMergeRejectsDifferentSignatures() public {
        NekoRenderer.Traits memory survivor = _baseTraits(5, 1);
        NekoRenderer.Traits memory consumed = _baseTraits(7, 2);
        generator.setRawTraits(neko.tokenSeed(1), survivor);
        generator.setRawTraits(neko.tokenSeed(2), consumed);
        bytes32 survivorSignature = generator.visualHash(survivor);
        bytes32 consumedSignature = generator.visualHash(consumed);

        vm.prank(COLLABORATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                NekoArt.CatSignatureMismatch.selector, survivorSignature, consumedSignature
            )
        );
        neko.merge(1, 2);
    }

    function testMutationRejectsMatchingSignaturesEvenWhenToysDiffer() public {
        NekoRenderer.Traits memory duplicate = _baseTraits(5, 1);
        generator.setRawTraits(neko.tokenSeed(1), duplicate);
        duplicate.toy = 2;
        generator.setRawTraits(neko.tokenSeed(2), duplicate);
        bytes32 signature = generator.visualHash(duplicate);

        vm.prank(COLLABORATOR);
        vm.expectRevert(abi.encodeWithSelector(NekoArt.CatSignatureMatch.selector, signature));
        neko.mutate(1, 2, 0x1000);
    }

    function testMutationRejectsSelectionThatDoesNotChangeSurvivor() public {
        NekoRenderer.Traits memory survivor = _baseTraits(5, 1);
        NekoRenderer.Traits memory consumed = _baseTraits(7, 1);
        generator.setRawTraits(neko.tokenSeed(1), survivor);
        generator.setRawTraits(neko.tokenSeed(2), consumed);

        vm.prank(COLLABORATOR);
        vm.expectRevert(NekoArt.MutationHasNoEffect.selector);
        neko.mutate(1, 2, 0x1000);
    }

    function testFusionIsDisabledBeforeReveal() public {
        TestableNekoSeaDrop unrevealed =
            _deploy(NekoRenderer(address(generator)), _commitment(GENESIS_SEED));

        vm.prank(COLLABORATOR);
        vm.expectRevert(NekoArt.GenesisSeedNotRevealed.selector);
        unrevealed.merge(1, 1);

        vm.prank(COLLABORATOR);
        vm.expectRevert(NekoArt.GenesisSeedNotRevealed.selector);
        unrevealed.mutate(1, 1, 0);

        assertEq(unrevealed.totalSupply(), TEAM_SUPPLY, "unrevealed fusion changed supply");
        assertEq(unrevealed.ownerOf(1), COLLABORATOR, "unrevealed fusion changed first owner");
        assertEq(unrevealed.ownerOf(2), COLLABORATOR, "unrevealed fusion changed second owner");
    }

    function testFusionBurnClearsConsumedLiveStateButPreservesAncestry() public {
        NekoRenderer.Traits memory duplicate = _baseTraits(7, 2);
        generator.setRawTraits(neko.tokenSeed(1), _baseTraits(5, 1));
        generator.setRawTraits(neko.tokenSeed(2), duplicate);
        generator.setRawTraits(neko.tokenSeed(3), duplicate);
        vm.prank(COLLABORATOR);
        neko.merge(2, 3);
        uint16 historicalRoot = neko.currentRoot(2);

        vm.prank(COLLABORATOR);
        neko.mutate(1, 2, 0x0008);

        assertEq(neko.mutationCount(2), 0, "fusion burn retained mutation count");
        assertEq(neko.duplicateMergeCount(2), 0, "fusion burn retained duplicate count");
        assertEq(neko.currentRoot(2), historicalRoot, "fusion burn erased ancestry root");
        vm.expectRevert(IERC721A.OwnerQueryForNonexistentToken.selector);
        neko.fusionMass(2);
        assertEq(neko.fusionMass(1), 3, "survivor did not absorb the consumed tree's mass");
    }

    function testFusionBurnSkipsTheTransferValidator() public {
        address validator = address(0x7A11);
        vm.etch(validator, hex"60006000fd");
        neko.setTransferValidator(validator);
        NekoRenderer.Traits memory duplicate = _baseTraits(5, 1);
        generator.setRawTraits(neko.tokenSeed(1), duplicate);
        duplicate.toy = 2;
        generator.setRawTraits(neko.tokenSeed(2), duplicate);

        vm.prank(COLLABORATOR);
        neko.merge(1, 2);

        assertEq(neko.fusionMass(1), 2, "merge under a validator mass mismatch");
        vm.prank(COLLABORATOR);
        vm.expectRevert();
        neko.transferFrom(COLLABORATOR, BOB, 1);
    }

    function _assertAncestryNode(
        uint16 nodeId,
        uint16 expectedParentA,
        uint16 expectedParentB,
        NekoArt.FusionAction expectedAction,
        uint16 expectedMask,
        string memory reason
    ) private view {
        (uint16 parentA, uint16 parentB, NekoArt.FusionAction action, uint16 mutationMask) =
            neko.ancestryNode(nodeId);
        if (
            parentA != expectedParentA || parentB != expectedParentB || action != expectedAction
                || mutationMask != expectedMask
        ) {
            revert(reason);
        }
    }
}
