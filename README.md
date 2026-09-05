# 云端构思板

这是部署到 Netlify、使用 Supabase 管理账号、构思卡片和私有截图，并通过服务端 DeepSeek Function 整理原始想法的个人构思板。

公开 GitHub 仓库 [cloud-idea-board](https://github.com/jackygilbert498-debug/cloud-idea-board) 是唯一开发与发布源。本地历史目录 `C:\Users\zfy20\Desktop\任务看板\云端部署` 仅作为迁移前快照只读保留；不要再从该目录同步代码或发起部署。

## 产品能力

核心流转为 **构思 → 待完成 → 进行中 → 已完成**。已完成区只展示今天完成的最近 3 条，其余内容进入可搜索、可恢复的档案。AI 梳理只发送当前卡片的原始文字，并在用户明确采用后写回整理稿。

桌面端支持多张截图的粘贴、拖入、上传、排序、查看和下载；手机端使用紧凑单列编辑文字并查看截图。附件通过 `pending → ready` 上传和 `ready → deleting` 删除状态收敛，界面只展示 `ready`。当前可重复迁移会保护已有 `sort_order`，重跑不会重置附件顺序。

登录页默认勾选“在这台设备保持登录”，Supabase 会话写入 `localStorage`，浏览器重启后仍可登录。取消勾选后，会话只写入当前标签页的 `sessionStorage`，关闭该标签页会话即失效；复制标签页可继承复制当刻的会话快照，但每个页面实例使用独立的 SDK 通道 key，之后的登录/退出事件不会跨页串写。应用只在勾选时保存 trim 后的邮箱；取消会移除已记邮箱，密码始终不写入应用存储，由浏览器密码管理器处理。

个人账号页显示当前邮箱、会话方式和构建短 SHA（本地未注入合法 SHA 时显示“开发版”），并提供修改密码、退出当前设备、退出所有设备、退出并清除当前账号本机数据。清理不会影响其他账号、Supabase Auth 存储或无关浏览器数据。

## 本地开发与验证

需要 Node.js 22（最低 `22.13.0`）。首次安装依赖运行 `npm.cmd ci`，日常开发运行 `npm.cmd run dev`。Vite 开发服务只提供页面；AI 接口需要 Netlify Functions 环境，服务端密钥不得进入浏览器构建。

本地交付前运行：

```powershell
npm.cmd run verify
```

`verify` 包含 lint、TypeScript、unit、regression 和发布契约测试。完整构建门禁还需先提供无权限公开测试用的 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`；`VITE_BUILD_SHA` 可显式提供，缺省时从当前 git HEAD 获取。然后运行：

```powershell
npm.cmd run verify:release
```

`build:release` 与 `verify:release` 都会先校验 SHA，并将同一构建身份注入前端及 Netlify 最终打包的唯一 Function 源码；Netlify 使用 `verify:netlify`，从平台构建期 `COMMIT_REF` 取得该 SHA。GitHub Actions 用 `github.sha` 调用 `verify:release`。任何入口都不会接受任意非 SHA 字符串。

测试使用内存 PostgreSQL，不访问线上 Supabase，也不能替代远端双会话并发验收。初始化、迁移、Netlify 变量和发布步骤见 [部署说明](./部署说明.md)，逐步证据格式见 [发布检查清单](./docs/operations/release-checklist.md)。

## 当前边界

这是个人产品，不包含团队、管理员后台、成员列表或 service-role 客户端能力；账号仍由 Supabase 管理员创建。公开源码和本地测试通过不等于线上验收完成：真实数据库并发门禁、固定预览、登录后桌面与 393px 验收未执行时必须记录为 `pending_external`。
