# 跑得快记分 v1.1 — 牌桌皮肤 + 多手机实时联机 设计文档

日期：2026-07-22
状态：已与用户确认
前置：v1.0 设计见 `2026-07-22-paodekuai-scorer-design.md`（结算规则、数据模型不变）

## 1. 目标

1. **界面美化**：整体换成"打牌氛围"的深绿牌桌毡面风格。
2. **多手机实时联机**：多台手机实时查看同一场比分；房主可开关「允许他人修改」。
3. **保留单机模式**：本地场逻辑完全不变，每次开场由用户选择本地/联机。
4. 顺路补上 v1.0 遗留：**作废本场**（误建的场可整场作废，不进历史）。

## 2. 模式与入场流程

- 首页「开新一场」→ 先选 **本地场**（现有流程，完全离线）或 **联机场**。
- **创建联机场**（房主）：选玩家、设单价 → 云端建房，生成 **6 位数字房号**
  （6 位是为了防止外人瞎猜房号看到金额；平时发链接进房，极少手输）。
  记分主页显示房号与「邀请牌友」按钮（复制 `链接?room=房号` 文本）。
- **加入联机场**：首页「加入联机场」输入房号，或直接点开带 `?room=` 的链接自动进房。
  进房后看到实时积分榜、每局明细、结算页，与房主完全同屏。
- 历史记录、备份、分享战绩等既有功能不变，对两种场统一可用。

## 3. 权限模型

- 每台手机首次使用联机时自动获得一个**匿名设备身份**（Firebase 匿名认证，
  用户无感知，凭证存 localStorage `runfast.sync.v1`）。
- 建房设备的 uid 记为 `creatorUid`（房主）。
- 房主记分主页有开关 **「允许他人修改」**（默认关）：
  - 关：非房主只读——记一局/改/删/玩家管理/结束按钮不渲染；
  - 开：所有进房设备可记一局、改删局、玩家管理，实时互见。
- 「结束本场」「作废本场」「开关允许他人修改」**始终仅房主可操作**。
- 权限由 **Firebase 安全规则在云端强制**（见 §5），前端隐藏按钮只是体验层。

## 4. 同步机制（无 SDK，纯 REST + SSE）

不引入 Firebase JS SDK，保持单文件零依赖交付。用平台的开放接口：

- **匿名登录**：`POST identitytoolkit.googleapis.com/v1/accounts:signUp?key=<apiKey>`
  → `idToken`(1h)/`refreshToken`/`localId`(uid)；过期用
  `POST securetoken.googleapis.com/v1/token?key=<apiKey>` 刷新。
- **实时订阅**：`EventSource("https://<db>.firebasedatabase.app/rooms/<code>.json?auth=<idToken>")`，
  处理 `put`/`patch`/`keep-alive`/`auth_revoked` 事件；`auth_revoked` 时刷新 token 重连。
- **写入（防覆盖）**：读取时带 `X-Firebase-ETag: true` 拿 ETag，
  `PUT ... if-match: <etag>`；返回 412 说明别人先写了 → 以推送到的最新数据重放本次操作
  （操作粒度小：加一局/改一局/开关等，重放安全）。
- **断网/弱网**：顶部状态条显示 已连接/连接中…；EventSource 自动重连；
  联机场以云端数据为准，本地不缓存中间态。

### 云端数据模型

```json
rooms/<6位房号>: {
  "creatorUid": "abc123",
  "allowEdit": false,
  "updatedAt": 1753180000000,
  "session": { ...与本地 session 完全同构（见 v1.0 §5）... }
}
```

session 同构 ⇒ `logic.js` 全部纯函数直接复用，积分榜/结算/战绩图零改动。

### 生命周期

- 房主「结束本场」：`session.status='finished'` 写入云端 → 各端收到推送后
  **各自把 session 快照存入本地历史**（按 session.id 去重）。结束后房间**保留**，
  错过推送的人重进房仍可补存；房主结算页出现「关闭房间」按钮，确认后删除云端房间。
- 房主「作废本场」：二次确认后直接删除房间，不进任何人的历史。
- 本地场「作废本场」：二次确认后从 sessions 删除 active 场。
- 非房主中途退出/进入随时可行（无状态，进来即拉最新）。

## 5. Firebase 安全规则（部署到用户项目）

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": "auth != null",
        ".write": "auth != null && (
          (!data.exists() && newData.child('creatorUid').val() === auth.uid)
          || data.child('creatorUid').val() === auth.uid
          || (data.exists() && newData.exists()
              && data.child('allowEdit').val() === true
              && newData.child('creatorUid').val() === data.child('creatorUid').val()
              && newData.child('allowEdit').val() === data.child('allowEdit').val())
        )"
      }
    }
  }
}
```

语义：建房者登记自己为房主；房主全权（含删除）；其他人仅当 `allowEdit=true`
时可写，且不能篡改 `creatorUid`/`allowEdit`、不能删房。

## 6. 界面美化（牌桌皮肤）

与战绩分享图视觉统一，单机联机同一套：

- **底色**：深绿毡面渐变（#14532d → #0c3b20），页面四角淡淡的 ♠♥♣♦ 水印。
- **卡片**：奶白圆角面板浮在毡面上，如桌上的记分纸。
- **数字**：赢家金色（#fbbf24）、输家浅绿（#86efac），沿用分享图配色。
- **按钮**：主按钮金色描边墨绿底（筹码感）；数字键盘做成小牌面（白底黑字圆角）。
- **标题栏**：房号/连接状态徽章融入毡面风格。
- 保持大字号、大按钮、移动端优先；只动 CSS 与少量装饰性标记，不改交互结构。

## 7. 一次性配置流程（用户侧，约 10 分钟）

实现阶段进行到联机功能时，提供图文步骤：

1. 用 Google 账号进 console.firebase.google.com 建免费项目（Spark 计划）；
2. 开启 **Realtime Database**（选亚洲区域）+ 开启 **匿名登录**（Authentication → Anonymous）；
3. 把 §5 的安全规则贴进 Rules 页签发布；
4. 把项目设置里的 `apiKey` 和 `databaseURL` 两个值发给我 → 我写入应用并重新部署。

费用：Spark 免费层（1GB 存储/10GB 下载/月），记分数据每场几 KB，用不完。
注意：Firebase 在中国大陆无法访问；牌友网络需能打开现有 GitHub Pages 链接。

## 8. 源码结构变化

- 新增 `src/sync.js`：匿名认证、SSE 订阅、ETag 写入、重连/重放状态机；
  暴露窄接口（`createRoom/joinRoom/applyOp/setAllowEdit/leave` + 事件回调），
  可插拔（将来加局域网后端不动 app.js）。
- `src/app.js`：开场模式选择、进房 UI、状态条、按钮权限门控、作废本场。
- `src/style.css`：牌桌皮肤全面改版。
- `firebaseConfig`（apiKey/databaseURL）以常量嵌入构建产物（公开无害，安全靠规则）。
- `logic.js`、`share-card.js`、`build.js` 不变。

## 9. 测试策略

- `logic.js` 既有 13 测不变；`sync.js` 中纯逻辑部分（房号生成、操作重放合并、
  权限判定 `canEdit()`）拆成纯函数进 `node --test`。
- 联机端到端：拿到用户 Firebase 配置后，用浏览器双标签页（两个匿名身份）验证
  建房/进房/实时互见/权限开关/412 冲突重放/结束快照全链路。
- 皮肤改版：移动视口截图逐页检查 + 无横向溢出。

## 10. 范围外

语音播报、聊天、旁观人数、断线写锁、局域网后端（接口已预留）、房间自动过期清理。

## 11. 实施顺序

阶段 A（无需用户配置）：牌桌皮肤 + 作废本场 + 开场模式选择 UI 骨架；
阶段 B：sync.js + 权限门控（代码完成，纯函数测试过）；
阶段 C（需要用户 Firebase 配置）：真库端到端验证 → 构建 → 部署 GitHub Pages。
