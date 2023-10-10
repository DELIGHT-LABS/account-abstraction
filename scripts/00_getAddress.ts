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

    const deployedAccountContract = await deployments.get("SimpleAccountFactory");
    const accountContract = await hre.ethers.getContractAt(deployedAccountContract.abi, deployedAccountContract.address);

    // any data that can derive the AA address
    // the below data is an example and just a sha256 hash hex of an arbitrary text
    const salt = hre.ethers.utils.hexlify("0x4F9F10B304CFE9B2B11FCB1387F694E18F08EA358C7E9F567434D3AD6CBD7FC4");

    const getPrivKey = await accountContract.connect(deployer)
        .getAddress(
            deployer.getAddress(),
            salt
        );

    console.log("Derived address:", getPrivKey);
}

main();
