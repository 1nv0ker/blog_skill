#!/usr/bin/env node

import {spawn} from 'node:child_process'
import {lstat, realpath} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {WORKSPACE_ROOT, WorkspaceError, verifyWorkspace} from './workspace.mjs'

const SAFE_ENVIRONMENT_NAMES = new Set([
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
])

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function validatorEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => SAFE_ENVIRONMENT_NAMES.has(name.toUpperCase())),
  )
}

export async function validateOutput(
  articleArgument,
  {workspaceRoot = WORKSPACE_ROOT, env = process.env} = {},
) {
  const workspace = await verifyWorkspace({workspaceRoot})
  let article
  try {
    const requested = path.resolve(articleArgument)
    const info = await lstat(requested)
    if (!info.isFile() || info.isSymbolicLink() || path.extname(requested).toLowerCase() !== '.json') {
      throw new Error('invalid article')
    }
    article = await realpath(requested)
  } catch {
    throw new WorkspaceError('ARTICLE_INVALID', '文章 JSON 不存在或不是普通文件。')
  }
  if (!isInside(workspace.blogRoot, article)) {
    throw new WorkspaceError(
      'ARTICLE_LOCATION_INVALID',
      '文章 JSON 必须位于固定 blog 输出目录。',
    )
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workspace.publisherCli, 'validate', article], {
      cwd: workspace.publisherRoot,
      env: validatorEnvironment(env),
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', () =>
      reject(new WorkspaceError('VALIDATOR_START_FAILED', '无法启动本地 publisher 校验器。')),
    )
    child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 1 || args[0].startsWith('-')) {
    throw new WorkspaceError('ARGUMENT_INVALID', '请提供且仅提供一个 blog JSON 文件路径。')
  }
  process.exitCode = await validateOutput(args[0])
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`校验未执行：${error.message}`)
    process.exitCode = 1
  })
}
