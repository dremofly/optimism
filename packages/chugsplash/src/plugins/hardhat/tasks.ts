import * as path from 'path'
import * as fs from 'fs'

import { subtask, task, types } from 'hardhat/config'
import { SolcBuild } from 'hardhat/types'
import {
  TASK_COMPILE,
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
} from 'hardhat/builtin-tasks/task-names'
import pinataSDK from '@pinata/sdk'
import fetch from 'node-fetch'
import { add0x } from '@eth-optimism/core-utils'
import { ethers } from 'ethers'

import {
  validateChugSplashConfig,
  makeActionBundleFromConfig,
  ChugSplashConfig,
  CanonicalChugSplashConfig,
} from '../../config'
import { ChugSplashActionBundle } from '../../actions'
import { getContractArtifact, getStorageLayout } from './artifacts'
import { ChugSplashRegistryABI, ChugSplashManagerABI } from '../../autogen'

const TASK_CHUGSPLASH_LOAD = 'chugsplash:load'
const TASK_CHUGSPLASH_BUNDLE_LOCAL = 'chugsplash:bundle:local'
const TASK_CHUGSPLASH_BUNDLE_REMOTE = 'chugsplash:bundle:remote'
const TASK_CHUGSPLASH_VERIFY = 'chugsplash:verify'
const TASK_CHUGSPLASH_COMMIT = 'chugsplash:commit'
const TASK_CHUGSPLASH_FETCH = 'chugsplash:fetch'
const TASK_CHUGSPLASH_EXECUTE = 'chugsplash:execute'

subtask(TASK_CHUGSPLASH_LOAD)
  .addParam('deployConfig', undefined, undefined, types.string)
  .setAction(
    async (args: { deployConfig: string }, hre): Promise<ChugSplashConfig> => {
      // Make sure we have the latest compiled code.
      await hre.run(TASK_COMPILE, {
        quiet: true,
      })
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      let config = require(path.resolve(args.deployConfig))
      config = config.default || config
      validateChugSplashConfig(config)
      return config
    }
  )

subtask(TASK_CHUGSPLASH_BUNDLE_LOCAL)
  .addParam('deployConfig', undefined, undefined, types.string)
  .setAction(
    async (
      args: { deployConfig: string },
      hre
    ): Promise<ChugSplashActionBundle> => {
      const config: ChugSplashConfig = await hre.run(TASK_CHUGSPLASH_LOAD, {
        deployConfig: args.deployConfig,
      })

      const artifacts = {}
      for (const contract of Object.values(config.contracts)) {
        const artifact = await getContractArtifact(contract.source)
        const storageLayout = await getStorageLayout(contract.source)
        artifacts[contract.source] = {
          bytecode: artifact.bytecode,
          storageLayout,
        }
      }

      return makeActionBundleFromConfig(config, artifacts, process.env)
    }
  )

subtask(TASK_CHUGSPLASH_BUNDLE_REMOTE)
  .addParam('deployConfig', undefined, undefined, types.any)
  .setAction(
    async (
      args: { deployConfig: CanonicalChugSplashConfig },
      hre
    ): Promise<ChugSplashActionBundle> => {
      const artifacts = {}
      for (const source of args.deployConfig.inputs) {
        const solcBuild: SolcBuild = await hre.run(
          TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
          {
            quiet: true,
            solcVersion: source.solcVersion,
          }
        )

        let output: any // TODO: Compiler output
        if (solcBuild.isSolcJs) {
          output = await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, {
            input: source.input,
            solcJsPath: solcBuild.compilerPath,
          })
        } else {
          output = await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLC, {
            input: source.input,
            solcPath: solcBuild.compilerPath,
          })
        }

        for (const fileOutput of Object.values(output.contracts)) {
          for (const [contractName, contractOutput] of Object.entries(
            fileOutput
          )) {
            artifacts[contractName] = {
              bytecode: add0x(contractOutput.evm.deployedBytecode.object),
              storageLayout: contractOutput.storageLayout,
            }
          }
        }
      }

      return makeActionBundleFromConfig(
        args.deployConfig,
        artifacts,
        process.env
      )
    }
  )

subtask(TASK_CHUGSPLASH_FETCH)
  .addParam('configUri', undefined, undefined, types.string)
  .setAction(
    async (args: { configUri: string }): Promise<CanonicalChugSplashConfig> => {
      let config: CanonicalChugSplashConfig
      if (args.configUri.startsWith('ipfs://')) {
        config = await (
          await fetch(
            `https://cloudflare-ipfs.com/ipfs/${args.configUri.replace(
              'ipfs://',
              ''
            )}`
          )
        ).json()
      } else {
        throw new Error('unsupported URI type')
      }

      return config
    }
  )

task(TASK_CHUGSPLASH_COMMIT)
  .setDescription('Commits a ChugSplash config file with artifacts to IPFS')
  .addParam('deployConfig', 'path to chugsplash deploy config')
  .addParam('pinataApiKey', 'pinata API key')
  .addParam('pinataSecretKey', 'pinata secret key')
  .setAction(
    async (
      args: {
        deployConfig: string
        pinataApiKey: string
        pinataSecretKey: string
      },
      hre
    ) => {
      const config: ChugSplashConfig = await hre.run(TASK_CHUGSPLASH_LOAD, {
        deployConfig: args.deployConfig,
      })

      // Initialize Pinata
      const pinata = pinataSDK(args.pinataApiKey, args.pinataSecretKey)

      // Test Pinata connection
      const auth = await pinata.testAuthentication()
      if (!auth.authenticated) {
        throw new Error(`pinata authentication failed: ${auth}`)
      }

      // We'll need this later
      const buildInfoFolder = path.join(
        hre.config.paths.artifacts,
        'build-info'
      )

      // Extract compiler inputs
      const inputs = fs
        .readdirSync(buildInfoFolder)
        .filter((file) => {
          return file.endsWith('.json')
        })
        .map((file) => {
          return JSON.parse(
            fs.readFileSync(path.join(buildInfoFolder, file), 'utf8')
          )
        })
        .map((content) => {
          return {
            solcVersion: content.solcVersion,
            solcLongVersion: content.solcLongVersion,
            input: content.input,
          }
        })

      // Publish config to IPFS
      const configPublishResult = await pinata.pinJSONToIPFS({
        ...config,
        inputs,
      })

      const bundle = await hre.run(TASK_CHUGSPLASH_BUNDLE_LOCAL, {
        deployConfig: args.deployConfig,
      })

      console.log(configPublishResult['IpfsHash'])
      console.log(bundle.root)
    }
  )

task(TASK_CHUGSPLASH_VERIFY)
  .setDescription('Checks if a deployment config matches a bundle hash')
  .addParam('configUri', 'location of the config file')
  .addParam('bundleHash', 'hash of the bundle')
  .setAction(
    async (
      args: {
        configUri: string
        bundleHash: string
      },
      hre
    ): Promise<{
      config: CanonicalChugSplashConfig
      bundle: ChugSplashActionBundle
    }> => {
      const config: CanonicalChugSplashConfig = await hre.run(
        TASK_CHUGSPLASH_FETCH,
        {
          configUri: args.configUri,
        }
      )

      const bundle: ChugSplashActionBundle = await hre.run(
        TASK_CHUGSPLASH_BUNDLE_REMOTE,
        {
          deployConfig: config,
        }
      )

      if (bundle.root !== args.bundleHash) {
        throw new Error('bundle hash does not match')
      }

      return {
        config,
        bundle,
      }
    }
  )

task(TASK_CHUGSPLASH_EXECUTE)
  .setDescription('Executes a deployment to completion')
  .addParam('configUri', 'location of the config file')
  .addParam('bundleHash', 'hash of the bundle')
  .addParam('registry', 'registry address')
  .addParam('executor', 'deployer address')
  .setAction(
    async (
      args: {
        configUri: string
        bundleHash: string
        registry: string
        executor: string
      },
      hre: any
    ) => {
      const {
        config,
        bundle,
      }: {
        config: CanonicalChugSplashConfig
        bundle: ChugSplashActionBundle
      } = await hre.run(TASK_CHUGSPLASH_VERIFY, {
        configUri: args.configUri,
        bundleHash: args.bundleHash,
      })

      if (!hre.ethers) {
        throw new Error('install @nomiclabs/hardhat-ethers to use this task')
      }

      // Will throw if signer is not unlocked
      const signer = await hre.ethers.getSigner(args.executor)

      const ChugSplashRegistry = new ethers.Contract(
        args.registry,
        ChugSplashRegistryABI,
        signer
      )

      const manager = await ChugSplashRegistry.registry(config.options.name)
      if (manager === ethers.constants.AddressZero) {
        throw new Error(`no manager found for name: ${config.options.name}`)
      }

      const ChugSplashManager = new ethers.Contract(
        manager,
        ChugSplashManagerABI,
        signer
      )
    }
  )
