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
线上服务器 160.30.231.132（宝塔面板）
   ├─ PM2 进程 "runfast" 跑 server.js，监听本机 :8787（不对外）
   └─ Nginx 把 https://ipa.ydyrx.top/ 反向代理到 :8787（对外的入口，带 HTTPS）
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

2）线上服务器：打开宝塔面板 `http://160.30.231.132:19157/` → 左侧「终端」，粘贴运行：
```bash
bash /www/wwwroot/runfast/update.sh
```
它会自动：`git pull` → `pm2 restart runfast` → 显示状态。看到 `OK -> https://ipa.ydyrx.top/` 就好了。

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
- **服务器 `/www/wwwroot/runfast/update.sh`**：拉代码 + 重启。用法 `bash /www/wwwroot/runfast/update.sh`。内容就是：
  ```bash
  cd /www/wwwroot/runfast
  git pull
  pm2 restart runfast
  pm2 save
  pm2 status runfast
  ```

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
| 服务器 IP | `160.30.231.132` |
| 宝塔面板 | `http://160.30.231.132:19157/` |
| 手机联机地址 | `https://ipa.ydyrx.top/` |
| 代码目录 | `/www/wwwroot/runfast` |
| 进程（PM2） | 名字 `runfast`，端口 `8787`（仅本机）|
| 对外入口 | Nginx 反代 443 → 127.0.0.1:8787 |
| Nginx 配置 | `/www/server/panel/vhost/nginx/ipa.ydyrx.top.conf` |
| 配置备份 | `/root/ipa.ydyrx.top.conf.bak`（改坏了可还原）|
| SSL 证书 | Let's Encrypt `/etc/letsencrypt/live/ipa.ydyrx.top/`（自动续期）|
| GitHub 仓库 | `github.com/jrlingyin888/runfast` |

---

## 六、常见问题 / 排错

- **改了前端，线上没变？** 十有八九是本机忘了 `node build.js`；重新 build → push → 服务器 `git pull` 即可。手机记得**硬刷新**一次。
- **改了 server.js，线上没变？** 后端改动必须 `pm2 restart runfast` 才生效。
- **服务好像挂了？** 宝塔终端 `pm2 status` 看状态，`pm2 logs runfast` 看报错，`pm2 restart runfast` 重启。
- **反代改坏了、站点打不开？** 还原备份：`cp /root/ipa.ydyrx.top.conf.bak /www/server/panel/vhost/nginx/ipa.ydyrx.top.conf && nginx -t && nginx -s reload`。
- **端口/安全组？** 我们对外只用 443（域名），8787 只在服务器本机，**不需要**在云安全组开 8787。
- **房间数据安全吗？** **房号即口令**：这个服务没有账号体系，`GET /rooms/<6位房号>` 谁都能读——房间里全部玩家名、全部记分流水，以及**建房人的设备 id** 都在返回里；拿着这个设备 id 就能 `DELETE` 掉该房间。房号只有 6 位数字（一百万种），公网部署下是可以被扫出来的。因此**别把房号/二维码贴到公开的群或网页**，打完让建房人在结算页「关闭房间」（战绩已在各人手机的历史里，删房不影响）。这是无账号身份模型的固有属性，不是可以打补丁修掉的 bug。

---

## 七、附：彻底删除旧的 IPA 测试项目（可选，需你自己执行）

旧 IPA 后台是个 Docker 容器，已经**停掉**且不再对外。要彻底清理（永久删除，删了要重装才有），在宝塔终端执行：

```bash
# 1) 删容器 + 镜像
cd /www/wwwroot/ipa-distributor
docker compose down --rmi all
# 2) 删项目源码目录
rm -rf /www/wwwroot/ipa-distributor
```

> ⚠️ **不要删** `/www/wwwroot/ipa-distributor-acme` 这个目录——它是 `ipa.ydyrx.top` 证书续期要用的（跑得快现在也靠这张证书）。
> 另外服务器上还有 `defense-console`、`akshare` 两个别的容器，**不是**这个项目的，别动。
