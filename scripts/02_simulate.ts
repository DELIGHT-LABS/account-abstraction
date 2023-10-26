import { ethers } from "ethers";
import { resolveProperties } from "ethers/lib/utils"
import { ethers as hardhatEth } from "hardhat"
import * as utils from "@account-abstraction/utils";
import * as simpleAccount from "./SimpleAccount.json";
import { AccountUtils, UserOperation} from "./accountUtils"
import { deepHexlify } from "@biconomy/common";

async function main(){
    const hre = require('hardhat');
    const { deployments } = hre;

    const entryPoint = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
    const bundlerUrl = "http://10.0.3.135:4337";
    const accountAddress = "0xfA3Bb191e72FA6160947Fa12bF61EF3Ea6D8cC9B"
    const transferTargetAddress = "0x20C67309af3b1bfFAA90374e3485509db0F7D102"

    // change into the url of the bundler
    const provider = new ethers.providers.JsonRpcProvider("http://10.0.3.34:8545"); // goerli
    const bundler = new ethers.providers.JsonRpcProvider(bundlerUrl); // bundler

    const deployer = await hardhatEth.provider.getSigner()

    const deployedEntryPointContract = await deployments.get("EntryPoint");
    const entrypointContract = await hre.ethers.getContractAt(deployedEntryPointContract.abi, deployedEntryPointContract.address);

    const deployedFactoryContract = await deployments.get("SimpleAccountFactory");
    const factoryContract = await hre.ethers.getContractAt(deployedFactoryContract.abi, deployedFactoryContract.address);

    const accountContract = new ethers.Contract(accountAddress, simpleAccount.abi);
    const { chainId } = await provider.getNetwork();

    const accountUtil = new AccountUtils(
        deployer,
        provider,
        entryPoint,
        bundlerUrl,
        chainId
    );

    // creating initcode
    // if the account is not created yet, please generate an initcode with the blocked code below
    // and do not put sender & nonce into the field

    // const salt = "0x4F9F10B304CFE9B2B11FCB1387F694E18F08EA358C7E9F567434D3AD6CBD7FC4"
    // const createAccountTx = await factoryContract.createAccount(deployer.getAddress(), salt);
    // const initcode = hre.ethers.utils.solidityPack(
    //         ["address", "bytes"],
    //         [deployedFactoryContract.address, createAccountTx.data]
    //     );

    const options = {value: hre.ethers.utils.parseEther("0.001")};
    const chargeEthTx = await accountContract.populateTransaction.addDeposit();
    const execTx = await accountContract.populateTransaction.execute(
        transferTargetAddress,
        ethers.utils.parseEther("0.001"),
        "0x"
    );
    // const signedTx = await deployer.signTransaction(chargeEthTx);

    let sendETHOpStruct: Partial<UserOperation> = {
        sender: accountAddress, // already created
        nonce: await accountUtil.getNonce(accountAddress),
        initCode: "0x",
        // initCode: initcode,
        callData: execTx.data,
        // callGasLimit: "30000",
        // verificationGasLimit: "0x00",
        // preVerificationGas: "0x00",
        // maxFeePerGas: "0x01",
        // maxPriorityFeePerGas: "0x01",
        paymasterAndData: "0x",
        signature: "0x73c3ac716c487ca34bb858247b5ccf1dc354fbaabdd089af3b2ac8e78ba85a4959a2d76250325bd67c11771c31fccda87c33ceec17cc0de912690521bb95ffcb1b" // dummy sig
    };

    sendETHOpStruct = await accountUtil.calculateUserOpGasValues(sendETHOpStruct);
    console.log("curr op state");
    console.log(sendETHOpStruct);

    delete sendETHOpStruct.signature;
    const ethopHash = await accountUtil.getUserOpHash(sendETHOpStruct);
    console.log("userOpHash:", ethopHash);
    sendETHOpStruct.signature = await accountUtil.signUserOpHash(ethopHash);

    console.log("with signature");
    console.log(sendETHOpStruct);

    const hexifiedUserOp = deepHexlify(await resolveProperties(sendETHOpStruct));

    console.log("hexifiedUserOp");
    console.log(hexifiedUserOp);

    const resp = await bundler.send("eth_sendUserOperation", [hexifiedUserOp, entryPoint]);
    // const resp = await bundler.send("eth_estimateUserOperationGas", [sendETHOpStruct, entryPoint]);
    console.log("resp");
    console.log(resp);
}

main();
