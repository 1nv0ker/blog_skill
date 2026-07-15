import {execFile} from 'node:child_process'
import {lstat, readFile, realpath, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = path.resolve(scriptDirectory, '..', '..', '..')
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.local.json')
export const DEFAULT_REPOSITORY_ROOT = 'C:\\work\\MIYA-LLC-WEB'

const MAX_TOKEN_CHARACTERS = 4096
const MAX_TOKEN_FILE_BYTES = 8192
const execFileAsync = promisify(execFile)

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
$readMask = [System.Security.AccessControl.FileSystemRights]::ReadData -bor
  [System.Security.AccessControl.FileSystemRights]::ReadAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::ReadPermissions
foreach ($target in $args) {
  $acl = Get-Acl -LiteralPath $target
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if (($rule.FileSystemRights -band $readMask) -eq 0) { continue }
    try {
      $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
      exit 41
    }
    if ($allowed -notcontains $sid) { exit 41 }
  }
}
[Console]::Out.Write('SAFE')
`

export class ConfigError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

export async function assertTokenFilePermissions(
  tokenFile,
  {
    platform = process.platform,
    execFileImpl = execFileAsync,
    systemRoot = process.env.SystemRoot ?? 'C:\\Windows',
  } = {},
) {
  let fileInfo
  let directoryInfo
  try {
    fileInfo = await lstat(tokenFile)
    directoryInfo = await lstat(path.dirname(tokenFile))
  } catch {
    throw new ConfigError('TOKEN_PERMISSIONS_UNSAFE', 'Token file permissions cannot be verified.')
  }

  if (platform !== 'win32') {
    if ((fileInfo.mode & 0o077) !== 0 || (directoryInfo.mode & 0o077) !== 0) {
      throw new ConfigError(
        'TOKEN_PERMISSIONS_UNSAFE',
        'Token file and its directory must be readable only by the current user.',
      )
    }
    return
  }

  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  try {
    const {stdout} = await execFileImpl(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WINDOWS_ACL_SCRIPT,
        tokenFile,
        path.dirname(tokenFile),
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1024,
        env: {
          SystemRoot: systemRoot,
          windir: systemRoot,
        },
      },
    )
    if (stdout !== 'SAFE') throw new Error('unsafe ACL')
  } catch {
    throw new ConfigError(
      'TOKEN_PERMISSIONS_UNSAFE',
      'Token file and its directory must be readable only by the current user.',
    )
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

async function canonicalDirectory(directory, label) {
  try {
    const resolved = await realpath(path.resolve(directory))
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory')
    return resolved
  } catch {
    throw new ConfigError('CONFIG_BOUNDARY_INVALID', `${label}不存在或不是目录。`)
  }
}

async function readTokenFile(
  tokenFile,
  {projectRoot, repositoryRoot, permissionChecker = assertTokenFilePermissions},
) {
  let fileInfo
  try {
    fileInfo = await lstat(tokenFile)
  } catch {
    throw new ConfigError('TOKEN_FILE_MISSING', 'Token 文件不存在或无法读取。')
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new ConfigError('TOKEN_FILE_INVALID', 'Token 路径必须是普通文件，不能是符号链接。')
  }
  if (fileInfo.size <= 0 || fileInfo.size > MAX_TOKEN_FILE_BYTES) {
    throw new ConfigError('TOKEN_FORMAT_INVALID', 'Token 文件格式无效。')
  }
  const [resolvedTokenFile, resolvedProjectRoot, resolvedRepositoryRoot] = await Promise.all([
    realpath(tokenFile),
    canonicalDirectory(projectRoot, 'Skill 项目目录'),
    canonicalDirectory(repositoryRoot, 'Git 仓库目录'),
  ])
  if (
    resolvedTokenFile !== path.resolve(tokenFile) ||
    isInside(resolvedProjectRoot, resolvedTokenFile) ||
    isInside(resolvedRepositoryRoot, resolvedTokenFile)
  ) {
    throw new ConfigError(
      'TOKEN_LOCATION_UNSAFE',
      'Token 文件必须位于 Git 仓库和 Skill 项目之外。',
    )
  }

  await permissionChecker(resolvedTokenFile)

  let raw
  try {
    raw = await readFile(resolvedTokenFile, 'utf8')
  } catch {
    throw new ConfigError('TOKEN_FILE_MISSING', 'Token 文件不存在或无法读取。')
  }
  const oneLine = raw.endsWith('\r\n')
    ? raw.slice(0, -2)
    : raw.endsWith('\n')
      ? raw.slice(0, -1)
      : raw
  if (
    oneLine.length === 0 ||
    oneLine.length > MAX_TOKEN_CHARACTERS ||
    oneLine.trim() !== oneLine ||
    /[\r\n\0\uFEFF]/u.test(oneLine)
  ) {
    throw new ConfigError('TOKEN_FORMAT_INVALID', 'Token 文件必须只包含一行有效 Token。')
  }

  return {token: oneLine, tokenFile: resolvedTokenFile}
}

async function readConfigFile(configPath) {
  let fileInfo
  try {
    fileInfo = await lstat(configPath)
  } catch {
    throw new ConfigError(
      'CONFIG_MISSING',
      '找不到 config.local.json；请先把 Token 放入仓库外文件并运行配置命令。',
    )
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new ConfigError('CONFIG_INVALID', 'config.local.json 必须是普通文件。')
  }

  let config
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    throw new ConfigError('CONFIG_INVALID', 'config.local.json 不是有效 JSON。')
  }
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).length !== 1 ||
    typeof config.tokenFile !== 'string' ||
    !path.isAbsolute(config.tokenFile)
  ) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'config.local.json 只能包含绝对路径字段 tokenFile。',
    )
  }
  return config
}

export async function loadPublishingConfig({
  configPath = DEFAULT_CONFIG_PATH,
  projectRoot = PROJECT_ROOT,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  permissionChecker = assertTokenFilePermissions,
} = {}) {
  const config = await readConfigFile(path.resolve(configPath))
  return readTokenFile(path.resolve(config.tokenFile), {
    projectRoot,
    repositoryRoot,
    permissionChecker,
  })
}

export async function writePublishingConfig(
  tokenFile,
  {
    configPath = DEFAULT_CONFIG_PATH,
    projectRoot = PROJECT_ROOT,
    repositoryRoot = DEFAULT_REPOSITORY_ROOT,
    permissionChecker = assertTokenFilePermissions,
    replace = false,
  } = {},
) {
  if (typeof tokenFile !== 'string' || !path.isAbsolute(tokenFile)) {
    throw new ConfigError('CONFIG_INVALID', '请提供 Token 文件的绝对路径。')
  }
  const resolved = await readTokenFile(path.resolve(tokenFile), {
    projectRoot,
    repositoryRoot,
    permissionChecker,
  })
  try {
    await writeFile(
      path.resolve(configPath),
      `${JSON.stringify({tokenFile: resolved.tokenFile}, null, 2)}\n`,
      {encoding: 'utf8', flag: replace ? 'w' : 'wx', mode: 0o600},
    )
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new ConfigError('CONFIG_EXISTS', 'config.local.json 已存在；轮换路径时请显式覆盖。')
    }
    throw new ConfigError('CONFIG_WRITE_FAILED', '无法写入 config.local.json。')
  }
  return {configPath: path.resolve(configPath), tokenFile: resolved.tokenFile}
}
