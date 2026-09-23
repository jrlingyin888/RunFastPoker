# 跑得快联机 · 部署与更新指南

面向「不太懂后端」的你。改完代码后照着这份走，就能把新版本更新到线上。

---

## 一、这套东西长什么样（一分钟看懂）

```
你的 Mac（改代码）
   │  node build.js 生成 dist/index.html
   │  git push
   ▼
GitHub 仓库  github.com/jrlingyin888/runfast
   │  服务器 git pull 拉取
   ▼
线上服务器 140.210.12.252（宝塔面板）
   ├─ PM2 进程 "runfast" 跑 server.js，监听本机 :8787（不对外）
   └─ 宝塔「反向代理」站点把 https://ipa.ydyrx.top/ 转到 :8787（对外的入口，带 HTTPS）
```

- **手机联机地址：** `https://ipa.ydyrx.top/`（任何网络都能开，服务器常驻+开机自启）
- 服务器上 `server.js` 是**每次请求现读** `dist/index.html`，所以**只改前端**时 `git pull` 后立刻生效；**改了后端**（server.js/src/sync.js 等）才需要重启进程。为省心，下面的更新脚本统一都会重启一次，两种情况都覆盖。

---

## 二、改完代码，怎么更新到线上？

**关键：改了前端界面，本机一定要先 `node build.js`**（重新把 src 打包进 `dist/index.html`），否则线上还是旧的。

### 最省事的三种方式（任选其一）

**方式 A：直接让 Claude 上线（最省事）**
> 你只要说「帮我上线」。Claude 会在本机 build + 提交 + 推送，再进宝塔终端跑更新脚本，全程帮你做完。

**方式 B：两条命令（本机一条 + 服务器一条）**

1）本机（Mac）终端，在项目目录里跑：
```bash
bash deploy.sh "这次改了啥的简单说明"
```
它会自动：`node build.js` → `git add` → `git commit` → `git push`。

2）线上服务器：打开宝塔面板 `https://140.210.12.252:32510/`（要用带安全入口的完整地址登录）→ 左侧「终端」，粘贴运行：
```bash
bash /www/wwwroot/runfast/update.sh
```
它会自动：`git pull` → 打印当前版本 → `pm2 restart runfast` → 显示状态。**看倒数几行打印的提交号是不是你刚推的那个**，是才算上线；拉取失败时脚本会直接报错中止、不会重启旧代码。

**方式 C：完全手动（了解每步在干嘛）**

本机：
```bash
node build.js                 # 前端改动必须，重建 dist/index.html
node --test                   # 可选：跑测试确认没弄坏
git add -A
git commit -m "改了记分界面"
git push                      # 推到 GitHub（origin）
```
服务器（宝塔终端）：
```bash
cd /www/wwwroot/runfast
git pull                      # 拉最新代码
pm2 restart runfast           # 重启服务
pm2 save
```

> 更新过程中**正在玩的房间数据不会丢**（`server-data.json` 不在 git 里，`git pull` 不碰它）。

---

## 三、两个「一键脚本」说明

- **本机 `deploy.sh`**（仓库根目录，本次已加）：build + 提交 + 推送。用法 `bash deploy.sh "说明文字"`。
- **服务器 `/www/wwwroot/runfast/update.sh`**：拉代码 + 重启。用法 `bash /www/wwwroot/runfast/update.sh`。它**只在服务器上、不在 git 里**（已写进 `.git/info/exclude`），换服务器要照这个重建：
  ```bash
  #!/usr/bin/env bash
  # pull latest code and restart; if pull fails, abort WITHOUT restarting old code
  set -euo pipefail
  cd /www/wwwroot/runfast
  for i in 1 2 3 4 5; do git pull --ff-only && break; if [ "$i" = 5 ]; then echo "git pull FAILED, not restarting"; exit 1; fi; echo "pull retry $i"; sleep 3; done
  git log --oneline -1
  pm2 restart runfast
  pm2 save
  pm2 status runfast
  echo "OK -> https://ipa.ydyrx.top/"
  ```
  > 以前的版本不查 `git pull` 的返回值：拉取失败照样重启旧代码、照样打印 OK，白测过一轮。所以要带 `set -euo pipefail`。

> 想要「本机一条命令直接连服务器一起更新」（省掉服务器那步）？可以后续给服务器配一把 SSH 密钥，配好后 `deploy.sh` 最后自动远程执行更新。需要的话跟 Claude 说，会帮你配。

---

## 四、日常管理命令（在宝塔终端里跑）

| 目的 | 命令 |
|---|---|
| 看服务在不在线 | `pm2 status` |
| 看实时日志（排错） | `pm2 logs runfast` （Ctrl+C 退出）|
| 重启服务 | `pm2 restart runfast` |
| 停 / 启服务 | `pm2 stop runfast` / `pm2 start runfast` |
| 本机自测有没有在服务 | `curl -I http://127.0.0.1:8787/` （看到 200 就正常）|
| 改了 Nginx 后重载 | `nginx -t && nginx -s reload` |

---

## 五、服务器关键信息速查

| 项 | 值 |
|---|---|
| 服务器 IP | `140.210.12.252`（2026-09 起；旧的 `160.30.231.132` 已下线）|
| 宝塔面板 | `https://140.210.12.252:32510/`（要带安全入口登录）|
| 手机联机地址 | `https://ipa.ydyrx.top/` |
| 代码目录 | `/www/wwwroot/runfast` |
| Node / PM2 | apt 装的 Node 18.19 + `npm i -g pm2`；开机自启靠 `pm2-root` 服务 |
| 进程（PM2） | 名字 `runfast`，端口 `8787`（仅本机，公网连不上）|
| 对外入口 | 宝塔「网站 → 反向代理」里的 `ipa.ydyrx.top` → `http://127.0.0.1:8787` |
| Nginx 配置 | `/www/server/panel/vhost/nginx/ipa.ydyrx.top.conf`（宝塔生成，别手改反代那段）|
| SSL 证书 | 宝塔申请的 Let's Encrypt，放在 `/www/server/panel/vhost/cert/ipa.ydyrx.top/`，宝塔自动续签 |
| GitHub 仓库 | `github.com/jrlingyin888/runfast` |

---

## 六、常见问题 / 排错

- **改了前端，线上没变？** 十有八九是本机忘了 `node build.js`；重新 build → push → 服务器 `git pull` 即可。手机记得**硬刷新**一次。
- **改了 server.js，线上没变？** 后端改动必须 `pm2 restart runfast` 才生效。
- **服务好像挂了？** 宝塔终端 `pm2 status` 看状态，`pm2 logs runfast` 看报错，`pm2 restart runfast` 重启。
- **反代改坏了、站点打不开？** 去宝塔「网站 → 反向代理 → ipa.ydyrx.top → 设置」看；实在不行删掉按下面「七」重建（目标 `http://127.0.0.1:8787`，发送域名保持 `$http_host`）。
- **打开是「连接不是私密连接」、硬点进去是 400？** 说明请求没落到这个站点上，掉进了宝塔的兜底站点（`0.default.conf`：自签证书 + `return 400`）。多半是换了服务器、域名已经指过去了但站点没建——2026-09 换机就是这么挂的。
- **牌友那边不实时刷新？** 实时推送（SSE）最怕 Nginx 缓冲。`server.js` 已在推送响应里带 `X-Accel-Buffering: no`，Nginx 会自动对这条连接关掉缓冲，普通反代就够；想再加一道保险，可在 `/www/server/panel/vhost/nginx/extension/ipa.ydyrx.top/` 下放个 `.conf` 写 `proxy_buffering off;`，然后 `nginx -t && nginx -s reload`。
- **`update.sh` 拉代码很慢、报 `GnuTLS recv error` 或 `Failed to connect to github.com port 443`？** 国内服务器连 GitHub 看运气：2026-09 实测这台机器 DNS 解析 github.com 只给 `20.205.243.166`，而这个 IP 根本连不上；GitHub 另外几个 IP 能连。所以仓库里已设 `git config http.curloptResolve github.com:443:140.82.112.3,140.82.114.4,140.82.113.3,20.27.177.113`（只对这个仓库生效，不动系统 hosts），拉取从几分钟降到一两秒。哪天又连不上，先在宝塔终端逐个测：`timeout 6 bash -c '</dev/tcp/140.82.112.3/443' && echo OK`，把连不上的从这行里换掉。
- **端口/安全组？** 我们对外只用 443（域名），8787 只在服务器本机，**不需要**在云安全组开 8787。
- **房间数据安全吗？** **房号即口令**：这个服务没有账号体系，`GET /rooms/<6位房号>` 谁都能读——房间里全部玩家名、全部记分流水，以及**建房人的设备 id** 都在返回里；拿着这个设备 id 就能 `DELETE` 掉该房间。房号只有 6 位数字（一百万种），公网部署下是可以被扫出来的。因此**别把房号/二维码贴到公开的群或网页**，打完让建房人在结算页「关闭房间」（战绩已在各人手机的历史里，删房不影响）。这是无账号身份模型的固有属性，不是可以打补丁修掉的 bug。

---

## 七、换服务器 / 从零部署（2026-09 换机时整理）

服务器迁移时**跑得快这套不会自动跟过去**：代码、Node/PM2、`update.sh`、宝塔站点和证书全在旧机上。只要域名一指到新机就会挂（见上面「400」那条），所以**先在新机部署好、验证过，再改 DNS**。全程约 15 分钟，大头是 apt 装 npm。

1）宝塔终端里装环境、拉代码、起服务：
```bash
git config --global http.version HTTP/1.1          # 这类服务器连 GitHub 易报 GnuTLS 错，先设上
apt-get update && apt-get install -y nodejs npm     # Ubuntu 24 给的是 Node 18.19，够用
npm i -g pm2 --registry=https://registry.npmmirror.com
cd /www/wwwroot && git clone https://github.com/jrlingyin888/runfast.git runfast
cd runfast && git config http.curloptResolve github.com:443:140.82.112.3,140.82.114.4,140.82.113.3,20.27.177.113   # 见「六」GitHub 那条
PORT=8787 RUNFAST_NO_OPEN=1 pm2 start server.js --name runfast
pm2 startup systemd -u root --hp /root && pm2 save  # 开机自启
curl -I http://127.0.0.1:8787/                      # 看到 200 就对了
```
2）照「三」里的内容重建 `update.sh`，`chmod +x`，再 `echo update.sh >> .git/info/exclude`。

3）宝塔「网站 → 反向代理 → 添加反代」：域名 `ipa.ydyrx.top`，目标 `http://127.0.0.1:8787`，发送域名保持 `$http_host`（`/host` 入口页靠它算出公网地址）。

4）DNS 指向新机后，在该站点「设置 → SSL → 免费证书 → 申请证书」：品牌选 **Let's Encrypt**、文件验证；签好后「强制 HTTPS」会自动打开。

5）验收：手机打开 `https://ipa.ydyrx.top/`；两台设备进同一个房间，一边记一笔，另一边应在一秒内刷新。

> 旧机上没打完的房间在旧机的 `server-data.json` 里，要保留就在停旧机前把这个文件拷到新机同一目录（先 `pm2 stop runfast` 再拷，再 `pm2 start runfast`）。打完的战绩存在各人手机里，不受影响。
