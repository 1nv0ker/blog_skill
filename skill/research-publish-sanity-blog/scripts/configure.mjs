#!/usr/bin/env node

import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {loadPublishingConfig, writePublishingConfig} from './config.mjs'

function argumentError() {
  const error = new Error(
    'Use --check, or provide one absolute external token-file path with optional --replace.',
  )
  error.code = 'ARGUMENT_INVALID'
  return error
}

export function parseConfigureArguments(args) {
  if (!Array.isArray(args)) throw argumentError()
  if (args.length === 1 && args[0] === '--check') return {mode: 'check'}
  if (args.includes('--check')) throw argumentError()

  const replace = args.includes('--replace')
  const paths = args.filter((argument) => argument !== '--replace')
  if (
    paths.length !== 1 ||
    typeof paths[0] !== 'string' ||
    paths[0].startsWith('-') ||
    !path.isAbsolute(paths[0])
  ) {
    throw argumentError()
  }
  return {mode: 'write', tokenFile: paths[0], replace}
}

export async function runConfigureCommand(
  args,
  {
    loadConfig = loadPublishingConfig,
    writeConfig = writePublishingConfig,
    log = console.log,
  } = {},
) {
  const parsed = parseConfigureArguments(args)
  if (parsed.mode === 'check') {
    await loadConfig()
    log('Publishing configuration is valid; no token value was printed.')
    return {mode: 'check'}
  }

  await writeConfig(parsed.tokenFile, {replace: parsed.replace})
  log('Configuration saved: only the external token-file path was stored.')
  return {mode: 'write'}
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
