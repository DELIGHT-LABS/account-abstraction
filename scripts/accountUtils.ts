import { ethers, Signer, BigNumber, BigNumberish, BytesLike } from "ethers";
import { Bytes, arrayify, defaultAbiCoder, keccak256, hexlify } from "ethers/lib/utils";
import * as simpleAccount from "./SimpleAccount.json";
import { JsonRpcProvider, Provider } from "@ethersproject/providers";
import { sendRequest, HttpMethod, getTimestampInSeconds } from "./httpReq";

type UserOperation = {
    sender: string;
    nonce: BigNumberish;
    initCode: BytesLike;
    callData: BytesLike;
    callGasLimit: BigNumberish;
    verificationGasLimit: BigNumberish;
    preVerificationGas: BigNumberish;
    maxFeePerGas: BigNumberish;
    maxPriorityFeePerGas: BigNumberish;
    paymasterAndData: BytesLike;
    signature: BytesLike;
};

type JsonRpcError = {
    code: string;
    message: string;
    data: any;
};

type Overrides = {
    callGasLimit?: BigNumberish;
    verificationGasLimit?: BigNumberish;
    preVerificationGas?: BigNumberish;
    maxFeePerGas?: BigNumberish;
    maxPriorityFeePerGas?: BigNumberish;
    paymasterData?: string;
    signature?: string;
};

interface GasOverheads {
    fixed: number;
    perUserOp: number;
    perUserOpWord: number;

    zeroByte: number;
    nonZeroByte: number;
    bundleSize: number;
    sigSize: number;
    multiplier: number;
  }

const DefaultGasLimits = {
    validateUserOpGas: 100000,
    validatePaymasterUserOpGas: 100000,
    postOpGas: 10877,
};

const DefaultGasOverheads: GasOverheads = {
    fixed: 21000,
    perUserOp: 22874, // 18300 <- bcnmy setting
    perUserOpWord: 4,
    zeroByte: 4,
    nonZeroByte: 16,
    bundleSize: 1,
    sigSize: 65,
    multiplier: 25,
};

type UserOpGasResponse = {
    preVerificationGas: string;
    verificationGasLimit: string;
    callGasLimit: string;
    maxPriorityFeePerGas: string;
    maxFeePerGas: string;
};

type EstimateUserOpGasResponse = {
    jsonrpc: string;
    id: number;
    result: UserOpGasResponse;
    error?: JsonRpcError;
};

class AccountUtils {
    signer: Signer;
    provider: Provider;
    entryPoint: string;
    bundlerUrl: string;
    chainId: number;

    constructor (_signer: Signer, _provider: Provider, _entryPoint: string, _bundlerUrl: string, _chainId: number) {
        this.signer = _signer;
        this.provider = _provider;
        this.entryPoint = _entryPoint
        this.bundlerUrl = _bundlerUrl;
        this.chainId = _chainId;
    }

    async getNonce(address: string, nonceKey?: number): Promise<BigNumber> {
        const nonceSpace = nonceKey ?? 0;
        try {
            const accountContract = new ethers.Contract(address, simpleAccount.abi);
            const nonce = await accountContract.nonce(nonceSpace);
            return nonce;
        } catch (e) {
            // if there is no nonce, 0 is default nonce
            return BigNumber.from(0);
        }
    }

    async estimateCreationGas(initCode?: string): Promise<BigNumberish> {
        if (initCode == null || initCode === "0x") return 0;
        const deployerAddress = initCode.substring(0, 42);
        const deployerCallData = "0x" + initCode.substring(42);
        return this.provider.estimateGas({ to: deployerAddress, data: deployerCallData });
    }

    async getVerificationGasLimit(initCode: BytesLike): Promise<BigNumber> {
        // Verification gas should be max(initGas(wallet deployment) + validateUserOp + validatePaymasterUserOp , postOp)
    
        const initGas = await this.estimateCreationGas(initCode as string);
        const validateUserOpGas = BigNumber.from(DefaultGasLimits.validatePaymasterUserOpGas + DefaultGasLimits.validateUserOpGas);
        const postOpGas = BigNumber.from(DefaultGasLimits.postOpGas);
    
        let verificationGasLimit = BigNumber.from(validateUserOpGas).add(initGas);
    
        if (BigNumber.from(postOpGas).gt(verificationGasLimit)) {
          verificationGasLimit = postOpGas;
        }
        return verificationGasLimit;
    }

    transformUserOP(userOp: Partial<UserOperation>): Partial<UserOperation> {
        try {
          const userOperation = { ...userOp };
          const keys: (keyof UserOperation)[] = [
            "nonce",
            "callGasLimit",
            "verificationGasLimit",
            "preVerificationGas",
            "maxFeePerGas",
            "maxPriorityFeePerGas",
          ];
          for (const key of keys) {
            if (userOperation[key] && userOperation[key] !== "0") {
              userOperation[key] = BigNumber.from(userOp[key]).toHexString();
            }
          }
          return userOperation;
        } catch (error) {
          throw `Failed to transform user operation: ${error}`;
        }
    };

    async estimateUserOpGasFromBundler(userOp: Partial<UserOperation>): Promise<UserOpGasResponse> {
        // expected dummySig and possibly dummmy paymasterAndData should be provided by the caller
        // bundler doesn't know account and paymaster implementation
        userOp = this.transformUserOP(userOp);
    
        const bundlerUrl = this.bundlerUrl;
    
        const response: EstimateUserOpGasResponse = await sendRequest({
          url: bundlerUrl,
          method: HttpMethod.Post,
          body: {
            method: "eth_estimateUserOperationGas",
            params: [userOp, this.entryPoint],
            id: getTimestampInSeconds(),
            jsonrpc: "2.0",
          },
        });
    
        const userOpGasResponse = response.result;
        for (const key in userOpGasResponse) {
          if (key === "maxFeePerGas" || key === "maxPriorityFeePerGas") continue;
          if (!userOpGasResponse[key as keyof UserOpGasResponse]) {
            throw new Error(`Got undefined ${key} from bundler`);
          }
        }
        return userOpGasResponse;
    }

    packUserOp(op: Partial<UserOperation>, forSignature = true): string {
        if (!op.initCode || !op.callData || !op.paymasterAndData) throw new Error("Missing userOp properties");
      
        if (forSignature) {
          return defaultAbiCoder.encode(
            ["address", "uint256", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32"],
            [
              op.sender,
              op.nonce,
              keccak256(op.initCode),
              keccak256(op.callData),
              op.callGasLimit,
              op.verificationGasLimit,
              op.preVerificationGas,
              op.maxFeePerGas,
              op.maxPriorityFeePerGas,
              keccak256(op.paymasterAndData),
            ],
          );
        } else {
          // for the purpose of calculating gas cost encode also signature (and no keccak of bytes)
          return defaultAbiCoder.encode(
            ["address", "uint256", "bytes", "bytes", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes", "bytes"],
            [
              op.sender,
              op.nonce,
              op.initCode,
              op.callData,
              op.callGasLimit,
              op.verificationGasLimit,
              op.preVerificationGas,
              op.maxFeePerGas,
              op.maxPriorityFeePerGas,
              op.paymasterAndData,
              op.signature,
            ],
          );
        }
    }

    calcPreVerificationGas(
        userOp: Partial<UserOperation>,
        overheads?: Partial<GasOverheads>
    ): BigNumber {
        const ov = { ...DefaultGasOverheads, ...(overheads ?? {}) };
        /* eslint-disable  @typescript-eslint/no-explicit-any */
        const p: UserOperation = {
          // dummy values, in case the UserOp is incomplete.
          paymasterAndData: "0x",
          preVerificationGas: BigNumber.from(21000), // dummy value, just for calldata cost
          signature: hexlify(Buffer.alloc(ov.sigSize, 1)), // dummy signature
          ...userOp,
        } as any;
      
        const packed = arrayify(this.packUserOp(p, false));
        const lengthInWord = (packed.length + 31) / 32;
        /**
         * general explanation
         * 21000 base gas
         * ~ 18300 gas per userOp : corresponds to _validateAccountAndPaymasterValidationData() method,
         * Some lines in _handlePostOp() after actualGasCost calculation and compensate() method called in handleOps() method
         * plus any gas overhead that can't be tracked on-chain
         * (if bundler needs to charge the premium one way is to increase this value for ops to sign)
         */
        const callDataCost = packed.map((x) => (x === 0 ? ov.zeroByte : ov.nonZeroByte)).reduce((sum, x) => sum + x);
        console.log("Call data cost:", callDataCost);
        const ret = Math.round(callDataCost + ov.fixed / ov.bundleSize + ov.perUserOp + ov.perUserOpWord * lengthInWord * ov.multiplier);
        if (ret) {
          return BigNumber.from(ret);
        } else {
          throw new Error("can't calculate preVerificationGas");
        }
    }

    async getPreVerificationGas(userOp: Partial<UserOperation>): Promise<BigNumber> {
        return this.calcPreVerificationGas(userOp);
    }

    async calculateUserOpGasValues(userOp: Partial<UserOperation>): Promise<Partial<UserOperation>> {
        if (!this.provider) throw new Error("Provider is not present for making rpc calls");
        const feeData = await this.provider.getFeeData();

        userOp.maxFeePerGas = userOp.maxFeePerGas ?? feeData.maxFeePerGas ?? feeData.gasPrice ?? (await this.provider.getGasPrice());

        userOp.maxPriorityFeePerGas =
          userOp.maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? (await this.provider.getGasPrice());

        if (userOp.initCode) userOp.verificationGasLimit = userOp.verificationGasLimit ?? (await this.getVerificationGasLimit(userOp.initCode));

        userOp.callGasLimit =
          userOp.callGasLimit ??
          (await this.provider.estimateGas({
            from: this.entryPoint,
            to: userOp.sender,
            data: userOp.callData,
          }));

        userOp.preVerificationGas = userOp.preVerificationGas ?? (await this.getPreVerificationGas(userOp));

        return userOp;
    }

    validateUserOp(userOp: Partial<UserOperation>, requiredFields: string[]): boolean {
        if ("sender" in requiredFields && "initCode" in requiredFields) {
          if (userOp.hasOwnProperty("sender") && userOp.hasOwnProperty("initCode")) {
              throw new Error("`sender` and `initCode` cannot exist in one UserOperation");
          }
        }

        for (const field of requiredFields) {
            if (field == "sender" || field == "initCode") continue;

            if (!userOp.hasOwnProperty(field)) {
                throw new Error(`${field} is missing`);
            }
        }

        return true;
    }
    
    async estimateUserOpGas(
        userOp: Partial<UserOperation>,
        overrides?: Overrides,
        skipBundlerGasEstimation?: boolean,
    ): Promise<Partial<UserOperation>> {
        const requiredFields = ["sender", "nonce", "initCode", "callData"];
        this.validateUserOp(userOp, requiredFields);
    
        let finalUserOp = userOp;
        const skipBundlerCall = skipBundlerGasEstimation ?? false;
        // Override gas values in userOp if provided in overrides params
        if (overrides) {
          userOp = { ...userOp, ...overrides };
        }
    
        if (!this.bundlerUrl || skipBundlerCall) {
          if (!this.provider) throw new Error("Provider is not present for making rpc calls");
          // if no bundler url is provided run offchain logic to assign following values of UserOp
          // maxFeePerGas, maxPriorityFeePerGas, verificationGasLimit, callGasLimit, preVerificationGas
          finalUserOp = await this.calculateUserOpGasValues(userOp);
        } else {
          delete userOp.maxFeePerGas;
          delete userOp.maxPriorityFeePerGas;
          // Making call to bundler to get gas estimations for userOp
          const { callGasLimit, verificationGasLimit, preVerificationGas, maxFeePerGas, maxPriorityFeePerGas } =
            await this.estimateUserOpGasFromBundler(userOp);
          // if neither user sent gas fee nor the bundler, estimate gas from provider
          if (!userOp.maxFeePerGas && !userOp.maxPriorityFeePerGas && (!maxFeePerGas || !maxPriorityFeePerGas)) {
            const feeData = await this.provider.getFeeData();
            finalUserOp.maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? (await this.provider.getGasPrice());
            finalUserOp.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? (await this.provider.getGasPrice());
          } else {
            finalUserOp.maxFeePerGas = maxFeePerGas ?? userOp.maxFeePerGas;
            finalUserOp.maxPriorityFeePerGas = maxPriorityFeePerGas ?? userOp.maxPriorityFeePerGas;
          }
          finalUserOp.verificationGasLimit = verificationGasLimit ?? userOp.verificationGasLimit;
          finalUserOp.callGasLimit = callGasLimit ?? userOp.callGasLimit;
          finalUserOp.preVerificationGas = preVerificationGas ?? userOp.preVerificationGas;
        }

        return finalUserOp;
    }

    async getUserOpHash(userOp: Partial<UserOperation>): Promise<string> {
      const userOpHash = keccak256(this.packUserOp(userOp, true));
      const enc = defaultAbiCoder.encode(["bytes32", "address", "uint256"], [userOpHash, this.entryPoint, this.chainId]);
      return keccak256(enc);
    }
    
    async signUserOpHash(userOpHash: string): Promise<string> {
        const sig = await this.signer.signMessage(arrayify(userOpHash));

        let signature = sig;

        const potentiallyIncorrectV = parseInt(signature.slice(-2), 16);
        if (![27, 28].includes(potentiallyIncorrectV)) {
          const correctV = potentiallyIncorrectV + 27;
          signature = signature.slice(0, -2) + correctV.toString(16);
        }
        if (signature.slice(0, 2) !== "0x") {
          signature = "0x" + signature;
        }

      return signature;
    }
}

export { AccountUtils };
export type { UserOperation };
