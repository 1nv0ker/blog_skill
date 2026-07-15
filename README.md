# 安装 research-publish-sanity-blog

## 1. 确认源码目录

Skill 源码目录应存在：

```text
C:\work\sanity-blog-research-publisher-skill\skill\research-publish-sanity-blog
```

## 2. 安装到 Codex

在 PowerShell 中执行一次：

```powershell
New-Item -ItemType Junction `
  -Path "C:\Users\zglxi\.codex\skills\research-publish-sanity-blog" `
  -Target "C:\work\sanity-blog-research-publisher-skill\skill\research-publish-sanity-blog"
```

如果目标目录已存在，请先确认它是否已指向同一源码目录；不要覆盖其他 Skill。

## 3. 验证与使用

关闭并新建一个 Codex 任务后，显式调用：

```text
$research-publish-sanity-blog WebTransport
```

目录联接会直接使用源码，因此后续更新无需重复安装。
