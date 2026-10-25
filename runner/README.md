# Codex Windows / Mac 接收器

Python 3.11+，仅标准库。电脑主动向看板 HTTPS 服务轮询，不开放公网端口。使用本机已登录的 Codex CLI，不需要付费 API key，不上传 ChatGPT 登录凭据。安装包适用于 Windows/macOS；Mac 真机配对、LaunchAgent 和实际执行仍待设备可操作时验收。

## 准备

解压到固定位置（例如 Windows 的 `C:\Tools\codex-receiver`，Mac 的 `~/Applications/codex-receiver`），保留 `runner` 目录内全部 Python 文件。安装 Python 3.11+ 和原生 Codex CLI，先在当前用户终端执行：

```text
codex --version
codex login
codex login status
```

接收器保留本机的模型等适用设置；启动时固定 `workspace-write` 沙箱、`approval_policy="never"`、内置 `model_provider="openai"` 和 `forced_login_method="chatgpt"`。需要人工批准的动作会失败并返回结果，接收器不会绕过沙箱。请仅映射你本人授权执行的项目。项目目录必须已经存在，保留其中现有草稿和未提交修改。

`doctor` 和真正执行前均要求可确认的 ChatGPT 登录，拒绝 API-key/WIF/未知登录、自定义 provider 定义或 API base 覆盖（包括已知用户/项目/受管 TOML 配置）。还会通过官方 CLI 的 `doctor --json` 检查实际生效的 provider 和登录模式；检查不支持或不确定时拒绝执行。子进程移除 `OPENAI_*`、`AZURE_OPENAI_*` 等 API key、地址和身份覆盖环境，不修改本机 Codex 配置、不读取 `auth.json`。当前检查已对 Codex 0.163 的诊断格式验证；更换 CLI 后应重新 `doctor`。这不代表任意本机配置或未来受管策略都已验收，模型权限、套餐额度和实际计费仍以官方服务为准。

## Windows

官方 `codex doctor` 汇总了身份、配置、网络、终端等多项检查。接收器分别核对明确的 ChatGPT 身份和官方 provider 字段，不把无关健康探针的失败误当成身份失效；身份/配置字段不明确、API登录、自定义计费路径、未知诊断格式或异常退出仍拒绝执行。

在 PowerShell 切换到解压后的 `codex-receiver` 目录。从网页 Codex 任务页生成一次性配对码，然后将示例域名、配对码、项目目录替换为真实值：

```powershell
python runner/receiver.py pair --server https://YOUR-BOARD.netlify.app --code YOUR-PAIR-CODE --name "我的 Windows" --project "board=C:\Projects\Board"
python runner/receiver.py doctor
python runner/receiver.py run
```

多项目可重复 `--project "ID=C:\绝对目录"`。CLI 不在 PATH 时，配对时增加 `--codex "C:\完整路径\codex.exe"`；不支持 `.cmd`、`.bat` 或 PowerShell 包装脚本。默认私人配置在 `%LOCALAPPDATA%\CloudIdeaBoard`，通过当前用户 SID 的 ACL 保护。

若从 MSIX 版桌面应用内安装，Windows 可能将逻辑 `%LOCALAPPDATA%` 映射到应用的 `LocalCache\Local`。以 `doctor` 输出的 `private state` 物理路径为准；以后从应用外运行、安装或卸载时都显式传同一 `--config` 路径。安装器自动解析物理程序/配置路径，任务名也由此路径计算，不要手写另一个目录对应的任务名。

确认前台运行后按 Ctrl+C 停止，再安装当前用户登录计划任务（需要同目录 `pythonw.exe`，无需管理员）：

```powershell
python runner/receiver.py install
python runner/receiver.py uninstall
```

计划任务隐藏运行，在下次当前用户登录时启动。`uninstall` 停止并删除本配置对应的计划任务，保留私人配置及未确认运行记录。网页“撤销设备”用于撤销服务器授权；卸载登录任务不等同撤销设备。

## Mac

在终端进入解压后的 `codex-receiver` 目录：

```bash
python3 runner/receiver.py pair --server https://YOUR-BOARD.netlify.app --code YOUR-PAIR-CODE --name "我的 Mac" --project "board=/Users/YOU/Projects/Board"
python3 runner/receiver.py doctor
python3 runner/receiver.py run
```

默认配置在 `~/.config/cloud-idea-board`，目录权限 0700，token/运行记录文件权限 0600。Codex 不在 PATH 时增加 `--codex /完整路径/codex`。确认前台运行后按 Ctrl+C，然后注册当前用户 LaunchAgent：

```bash
python3 runner/receiver.py install
python3 runner/receiver.py uninstall
```

LaunchAgent 位于 `~/Library/LaunchAgents/com.cloud-idea-board.receiver.<配置目录标识>.plist`，安装后立即启动，并在用户下次登录时运行。Mac 尚未进行真机验收；安装失败时保留配对配置，可先以前台 `run` 检查。卸载仅删除该配置对应的 LaunchAgent，保留配置/运行记录。

## 独立配置、日志和恢复

所有命令均支持 `--config ABSOLUTE_PRIVATE_DIRECTORY`，同一设备须始终使用同一配置目录。配置必须在映射项目和接收器目录之外；不要同步或上传 `config.json`。令牌只存本机私人目录，浏览器和 ZIP 均没有令牌。

`doctor` 只检查 CLI 登录及本机路径，既不领取任务也不注册后台服务。`run --once` 最多领取一个任务；`--task-timeout 7200` 指定执行秒数（1–86400）。标准日志只包含阶段/任务 ID，不记录完整提示词、工具输出或令牌。安装运行日志写入私人配置目录的 `receiver.log` 并自动轮转。

心跳/领取每20秒进行；运行每20秒续租，服务端租约90秒。取消、撤销或失租会停止本接收器启动的 Codex 进程树。Windows 使用独立 Job Object，Mac 使用独立进程组；不会按进程名结束其他 Codex。执行前先写 `active-run.json`，重启遇到未完成记录只报告 `needs_attention`，不会再次调用 Codex。未确认结果会重试写回，确认前不领取新任务。

强行终止 Mac 接收器自身时，已启动的进程组可能仍存活。重启遇到未确认完成的 Mac 记录，会报告 `needs_attention` 并持久保留 `orphanReviewRequired`，禁止领取任何新任务；不会凭一个可能被复用的 PID 杀进程。先检查并停止原 Codex 会话及其子进程、检查项目修改，或者重启 Mac 确保旧进程均已结束。然后停止后台接收器，在本机明确确认后解锁：

```bash
python3 runner/receiver.py uninstall
python3 runner/receiver.py recover --confirm-stopped
python3 runner/receiver.py install
```

所有命令应传同一 `--config`（如果配对时自定义过）。确认前不会继续领取，记录中的待确认结果仍先完成写回。正常退出、取消、超时、失租均会主动停止自有进程组。机器睡眠或断网超过租约后任务进入需人工检查状态，不自动重新执行。服务端拒绝旧租约时以服务端记录为准。

仅收集 Codex JSON 中的会话 ID 和最终 agent message；工具执行原文、stderr 和原始事件不会上传。任务输入长度按 Unicode 码点与服务端一致；结果保守限制20000 UTF-16单元，错误2000。常见 token/API-key 格式及 JSON/带引号的 access/refresh/id-token 字段会脱敏。格式识别无法证明所有自由文本均无秘密，最终回答仍应避免主动包含敏感内容。

## 验证与重新打包

源项目中运行（安装包中可直接执行 Python 测试，打包测试会因未包含 Node 构建脚本而跳过）：

```text
python -m unittest discover -s runner -p "test_*.py" -v
node scripts/package-receiver.mjs
```

输出 `runner/dist/codex-receiver.zip`。打包器只读取明确列出的接收器源码、测试及 README；不会扫描配置、node_modules、其他项目文件或用户草稿。打包输出包含文件清单、大小与 SHA-256。安装包不含 Python/Codex 运行时，需在目标设备自行安装。

只有本地假服务测试允许显式 `--allow-local-http`，且限定 localhost/127.0.0.1/::1；生产服务器必须使用 HTTPS。配对码10分钟有效且仅使用一次；若响应丢失，请在网页核对设备并撤销无本机令牌的旧配对，再生成新码。
