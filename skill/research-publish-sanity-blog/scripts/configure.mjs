#!/usr/bin/env node

import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {initializePublishingConfig, loadPublishingConfig} from './config.mjs'

function argumentError() {
  const error = new Error(
    'Use exactly --init or --check. Paths, tokens, and environment overrides are not accepted.',
  )
  error.code = 'ARGUMENT_INVALID'
  return error
}

export function parseConfigureArguments(args) {
  if (!Array.isArray(args)) throw argumentError()
  if (args.length === 1 && args[0] === '--check') return {mode: 'check'}
  if (args.length === 1 && args[0] === '--init') return {mode: 'init'}
  throw argumentError()
}

export async function runConfigureCommand(
  args,
  {
    loadConfig = loadPublishingConfig,
    initializeConfig = initializePublishingConfig,
    log = console.log,
  } = {},
) {
  const parsed = parseConfigureArguments(args)
  if (parsed.mode === 'check') {
    await loadConfig()
    log('Publishing configuration is valid; no token value was printed.')
    return {mode: 'check'}
  }

  const {configPath} = await initializeConfig()
  log(`Configuration template created at ${configPath}. Fill all four fields, then run --check.`)
  return {mode: 'init'}
}

async function main() {
  await runConfigureCommand(process.argv.slice(2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Configuration failed: ${error.code ?? 'CONFIGURE_FAILED'}.`)
    process.exitCode = 1
  })
}
