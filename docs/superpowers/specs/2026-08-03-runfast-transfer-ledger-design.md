# 跑得快记分 · 转账流水改版设计

日期：2026-08-03
状态：待实现

## 背景与问题

现行联机记分是「协作草稿」模式：赢家先点 → 每个输家各填「剩几张」→ 各自点确认 → **全部确认后由房主设备**自动提交这一局。实测暴露三类问题：

1. **卡死**：只有房主能写 `session.rounds`。房主锁屏、切后台、SSE 断线时，草稿全员确认了也不落局，牌桌停摆。
2. **报错**：多人同时点「谁赢了」写 `/draft`，同时抢座写 `/seats/<i>/claimedBy`，服务端 `canPatch` 返回 403 → 前端弹「没有权限或座位已被占」；未入座的人点则弹「观战中不能记分」。
3. **步骤重**：一局要走「选赢家 → N 个人各填 0–10 → N 个人各点确认」，还要先在大厅坐满座位房主才能开始。

用户诉求：改成微信小程序「打牌记账」的交互——**谁赢了就点谁的头像，弹框输分数，一笔就记完**。去掉房主特权，进房自己输名字，流水直接显示，结算功能保留。

## 核心设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 弹窗输入什么 | **分数**（= 张数），结算时 ×单价折成元 | 建场仍设单价，结算页仍出元和转账方案。全关不做特殊处理，自己输 20 比点两下选「全关×2」更快 |
| 没手机的人怎么记 | **弹窗里可改「付款人」** | 默认「我 → TA」，点左边头像换成任何人。流水标「××代记」 |
| 记错了怎么办 | **不提供删除，反向再转一笔** | 流水只增不删。天然无冲突、无篡改，也不用设计谁能删 |
| 结算入口 | **收进「⋯ 更多」菜单**，随时可看（只读） | 主页面只留头像行和流水，保持清爽 |
| 房主特权 | **完全取消** | 除「删除整个房间」外，所有人权限一致 |

## 数据模型

### 云端房间（新结构，扁平化 + 全 map）

```js
{
  creatorUid,                 // 仅用于删房鉴权，无其他特权
  sid: 's1699...',            // 本场 id；各端存历史时共用，避免重复入库
  createdAt: '2026-08-03T...',
  pricePerCardFen: 100,
  status: 'active' | 'finished',
  finishedAt,
  players: {
    p_ab12: { name: '华', uid: '设备id' | null, at: 1699... }
  },
  tx: {
    t_cd34: { from: 'p_ab12', to: 'p_ef56', points: 20, byUid: '设备id', at: 1699... }
  }
}
```

**为什么用 map 而不是数组**：现有 PATCH 是「按路径写」。两人同时往 `/seats/3`、`/rounds/5` 写会互相覆盖或撞权限校验。key 由客户端生成唯一 id（`p_`/`t_` + 随机 + 时间戳），十个人同一秒提交也各写各的格子，Node 服务器单线程逐个落盘，不可能冲突。

`uid: null` 表示这是「没带手机的人」——由别人代建、可被任何人代记、昵称也可被任何人改。

**移除的字段**：`phase`（大厅阶段）、`seats`（座位认领）、`draft`（协作草稿）、`allowEdit`、`session.activePlayers`、`session.rounds`（新场不再产生）。

### 本地历史（localStorage）

存档的 session 增加 `transfers` 数组，`players` 保持字符串数组：

```js
{
  id, createdAt, pricePerCardFen, status: 'finished', finishedAt,
  players: ['华', '小伶', '丽叶'],
  transfers: [ { id, from: '华', to: '丽叶', points: 20, at } ],  // 按 at 升序，from/to 存名字快照
  rounds: []                                                      // 旧场才有内容
}
```

存档时把云端 `tx` map 按 `at` 排序转成数组、把 `players` 的 pid 解析成名字快照，历史记录因此不依赖房间还在不在。

`db.version` 保持 `1`，只是多了可选字段；`importValid` 增加对 `transfers` 的校验（`from`/`to` 必须在 `players` 里、`points` 为正整数），旧备份仍能导入。

## 结算兼容（不做数据迁移）

一笔 transfer 的含义：`from` 减 `points` 分，`to` 加 `points` 分。某人净分 = 收到的分 − 支出的分；金额 = 净分 × `pricePerCardFen`。

`RunfastLogic.sessionNet(session)` 改为 **rounds 净额 + transfers 净额 相加**：

- 新场：只有 transfers
- 历史旧场：只有 rounds，照旧能看、能出战绩图
- 本地那个没打完的旧场：进去直接用新界面接着记，两边相加即可

`settleUp`（最少笔数转账）、`summaryText`（战绩文字）、`share-card.js`（战绩图）全部不改——它们只吃 `sessionNet` 的输出。

`roundTransfers`、`countedCards`、`HAND_SIZE` 保留，供历史旧场的「每局明细」渲染。

## 服务端权限（重写 `canPatch`）

| 路径 | 规则 |
|---|---|
| `/tx/<id>` | 任何带 `X-Device-Id` 的请求可写；**该 id 已存在则拒绝**（只增不删，顺带防改） |
| `/players/<id>` | 该 id 不存在时任何人可建 |
| `/players/<id>/name` | 改自己的（`uid === me`），或改 `uid == null` 的代记玩家 |
| `/players/<id>/uid` | 仅允许把 `uid == null` 的玩家绑到自己身上（认领没手机的人的身份） |
| `/status`、`/finishedAt` | 任何人可写（结束本场全开放） |
| 其他路径 | 拒绝 |
| `DELETE /rooms/<code>` | 仍限 `creatorUid`，防误删别人的房 |

`canWrite`（整房 PUT）只保留建房场景：房间不存在且 `neu.creatorUid === me`。房间已存在时一律拒绝整房覆盖——所有增量都走 PATCH。

## 界面

### 首页

- 「创建联机场」→ 只填**我的名字** + **每张牌单价** → 建房即进记分页，我是第一个玩家
- 「加入联机场」→ 输 6 位房号 → 输**我的名字** → 进记分页
- 扫码 / `?room=` 链接进来同样走「输名字」这一步；这一步另有「先看看」按钮 → 以观战身份进入（不建 player，只能看，点头像提示先加入）
- 名字在同一房间内不可重复，重名时提示换一个（流水按名字展示，重名无法辨认）
- 「回到联机房间」「历史记录」「导出/导入备份」「本地开新一场」保留

不再有选玩家名单那一步；常用名录降级为输名字时的快选建议。

### 记分主页（核心）

```
[顶栏] 已记 6 笔 · 1元/张                    [分享] [⋯]
[房号条] 房号 314159 · 4 人在玩 · 1 人观战
[头像行 横向滚动]
  (华)  (小伶)  (丽叶)  (小荣)  (＋)
  我     −12    +58     代      加人
  −29                   −17
[提示条] 谁赢了就点谁的头像 · 点自己头像改名或退出
[流水] 华 记分给 丽叶            20
      小伶 记分给 丽叶            6
      小荣 记分给 丽叶  [华代记]  4
```

- **头像**：名字首字 + 圆形色块，颜色按名字 hash 稳定取色。自己那个带高亮圈 + 「我」标；`uid == null` 的标「代」
- **净分**：红负绿正，沿用现有 `.pos` / `.neg`
- **点别人头像** → 支出弹窗
- **点自己头像** → 改昵称 / 退出房间
- **点 ＋** → 底部面板：「邀请牌友扫码」（复用现有二维码卡片分享）/「直接加没手机的人」（输名字，建 `uid: null` 的玩家）
- **流水**：按时间倒序，最新在上；代记的（`byUid` 不属于 `from` 玩家）标出代记人

### 支出弹窗

```
   (华) ⇅        支出 分数        (丽叶)
   点这里换人        →             赢家
        ┌─────────────────┐
        │       20        │
        └─────────────────┘
          = 20 元 · 全关就输 20
        [       支出       ]
```

- 付款人默认是我；点左边头像展开玩家列表换人（代记）
- 输入框 `inputmode="numeric"`，只收正整数
- 实时显示折算金额
- 未输名字的观战者点头像 → 提示「先点＋加入才能记分」
- 提交 = 一次 `PATCH /tx/<新id>`，成功即关窗；失败提示重试，不影响别人

### ⋯ 更多菜单

- 💰 结算方案（只读，随时可看）
- 🏁 结束本场
- ✏️ 改我的昵称
- 🚪 退出房间

### 结算页

沿用现有 `VIEWS.settle`：最终盈亏（±分 · ±元）、最少笔数转账方案、分享战绩图、复制战绩文字、查看全部流水。

「结束本场」→ 二次确认 → 写 `status: 'finished'` → 各端收到推送后快照存本地历史 → 跳结算页。任何人可点。

### 本地单机

同一套界面。区别：没有「我」，支出弹窗的付款人必须自己点选（默认上次选的人）。不维护两套 UI。

## 要删除的代码

`src/app.js`：`draftCard()` / `draftPickWinner` / `draftFill` / `draftToggleShutout` / `draftConfirm` / `draftOpenSeat` / `draftCloseSeat` / `draftOpen` / `cleanEntries` / `draftAllConfirmed` / `maybeAutoSaveDraft`、`VIEWS.record` 及 `pickWinner` / `pickCards` / `toggleShutout` / `saveRound` / `currentLosers` / `goRecord` / `cancelRecord` / `afterRecord`、`VIEWS.lobby` / `claimSeat` / `releaseSeat` / `startPlaying` / `emptySeatClaimCard`、`idTag` / `myOwnName` / `mySeatIdx` / `myNames` / `saveMyOwn` / `loadMyOwn`、`toggleAllowEdit`、`editRound` / `deleteRound`（旧场明细改为只读）。

`src/app.js`（续）：`commitSession()` —— 联机侧全部改走 PATCH，本地侧直接改 `db` 后 `saveDB()`。

`src/sync.js`：删 `canEdit` / `canAdmin` / `isDraftSaveable` / `draftToRound` / `mutate`（读-改-写整房已无使用者）；`observerCount` / `playingCount` 改按 `players` 计算；新增 `newPid()` / `newTxId()`。

`server.js`：`canPatch` 全部重写，`canWrite` 收窄为仅建房。

## 测试

- `test/logic.test.js`：新增 transfers 净额、rounds+transfers 混合场、transfers 场的 `settleUp` / `summaryText` 用例；保留全部 rounds 用例（旧场兼容）
- `test/server.test.js`：新增 `/tx/<新id>` 任何设备可写、`/tx/<已有id>` 被拒（append-only）、`/players` 建号与改名规则、`/status` 全开放、DELETE 仍限建房人；删掉 draft / seats 相关用例
- `test/sync.test.js`：删掉 draft 纯函数用例，新增 pid 生成唯一性与 `players`/`tx` 计数

## 验收标准

1. 建房人填名字+单价 → 直接进记分页，无大厅、无「开始」按钮
2. 第二台设备扫码 → 输名字 → 立刻出现在两端头像行
3. 三台设备同一秒点同一个赢家头像各提交一笔 → 三笔全部入账，无任何报错
4. 建房人退出/锁屏后，其余人继续记分正常入账
5. 代记：A 的弹窗把付款人改成 B，提交后流水显示「B 记分给 C · A代记」，B 的净分正确
6. 转错了反向再转一笔 → 双方净分归位
7. 「⋯ → 结算方案」随时可看；「结束本场」后各端本地历史都多一条，战绩图正常
8. 历史里的旧场（rounds 模式）仍能打开、看每局明细、出战绩图
9. `node --test` 全绿

## 不在本次范围

- 真实头像上传（用首字色块）
- 撤销/删除单笔流水（明确不做）
- 旧数据迁移脚本（靠净额相加天然兼容）
- 免登录跨设备身份（仍靠 localStorage 的设备 id）
