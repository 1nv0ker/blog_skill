# 安装 research-publish-sanity-blog

## 1. 确认 Skill 源码目录

将 `<skill-source-directory>` 替换为此项目的 `skill/research-publish-sanity-blog` 目录的绝对路径。

Codex 默认从 `~/.codex/skills` 发现 Skill；如果设置了 `CODEX_HOME`，则使用 `$CODEX_HOME/skills`。

## 2. 创建目录联接

### Windows PowerShell

```powershell
$source = "<skill-source-directory>"
$target = "$HOME\.codex\skills\research-publish-sanity-blog"
New-Item -ItemType Junction -Path $target -Target $source
```

如果使用了 `CODEX_HOME`，将 `$target` 改为：

```powershell
Join-Path $env:CODEX_HOME "skills\research-publish-sanity-blog"
```

### macOS 或 Linux

```bash
ln -s "<skill-source-directory>" "${CODEX_HOME:-$HOME/.codex}/skills/research-publish-sanity-blog"
```

目标目录已存在时，先确认它是否已经指向同一源码目录；不要覆盖其他 Skill。

## 3. 验证与使用

关闭并新建一个 Codex 任务后，显式调用：

```text
$research-publish-sanity-blog WebTransport
```

目录联接会直接使用源码，因此后续更新无需重复安装。
