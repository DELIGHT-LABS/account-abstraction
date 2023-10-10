// in actual wallet project, you may import as:
// import { ethers } from "ethers";
import { ethers } from "hardhat";

async function main(){
    const hre = require('hardhat');
    const { deployments } = hre;

    // get private key
    // please change into the frontend way
    const provider = ethers.provider
    const deployer = await provider.getSigner()

    const deployedEntryPointContract = await deployments.get("EntryPoint");
    const entrypointContract = await hre.ethers.getContractAt(deployedEntryPointContract.abi, deployedEntryPointContract.address);

    const deployedFactoryContract = await deployments.get("SimpleAccountFactory");
    const factoryContract = await hre.ethers.getContractAt(deployedFactoryContract.abi, deployedFactoryContract.address);

    // "salt" could be any arbitrary byte data but unique.
    // So, it could be users' password, ID/password combination, or a token from SSO
    //   or a SSO token + "index" (e.g. <token>/<index>)
    const salt = "0x4F9F10B304CFE9B2B11FCB1387F694E18F08EA358C7E9F567434D3AD6CBD7FC4"
    const createAccountTx = await factoryContract.createAccount(deployer.getAddress(), salt);
    const initcode = hre.ethers.utils.solidityPack(
            ["address", "bytes"],
            [deployedFactoryContract.address, createAccountTx.data]
        );
    
    // getSenderAddress() returns its address by revert message
    // so the tx should revert and it raises error
    // try ... catch clause is essential but need to find an appropriate error
    let getAddressTx;
    try {
        getAddressTx = await entrypointContract.connect(deployer)
            .getSenderAddress(
                initcode,
                { gasLimit: "50000" }
            );
        
        await getAddressTx.wait();
    } catch (e) {}

    // take the reverted transaction and parse the error message
    const revertedGetAddressTx = await provider.getTransaction(getAddressTx.hash);
    console.log(revertedGetAddressTx);

    const revertedReturnWithAddress = await provider.call({
        data: revertedGetAddressTx.data,
        to: revertedGetAddressTx.to,
    });

    const iface = new hre.ethers.utils.Interface(deployedEntryPointContract.abi);
    const derivedAddress = iface.parseError(revertedReturnWithAddress);

    console.log("Derived address:", derivedAddress.args.sender);
}

main();
